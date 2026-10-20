import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIncidentContext, jsonBytes, toRuntimeSafeEvidence } from '../incident-context.js';
import { buildInvestigationContext } from '../investigation-context.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function incident(): IncidentRow {
  return {
    id: 'inc-fresh',
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp',
    first_seen: '2026-08-20T10:00:00.000Z',
    last_seen: '2026-08-20T10:30:00.000Z',
    event_count: 2,
    severity: 'warning',
  };
}

function evidence(id: string, kind: string, collectedAt: string): EvidenceRecord {
  return {
    id,
    incidentId: 'inc-fresh',
    nodeId: 'test-svc-02',
    source: 'host',
    kind,
    collectedAt,
    data: { id },
    status: 'succeeded',
  };
}

const realLogs = JSON.parse(readFileSync(new URL('./fixtures/dataasset-fault-logs.json', import.meta.url), 'utf8')) as {
  eventTime: string;
  data: { lines: string[]; truncated: boolean };
};
const BOUNDS = { maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20 };

function logEvidence(data: unknown): EvidenceRecord {
  return { ...evidence('fault-logs', 'docker.logs', realLogs.eventTime), source: 'docker', data };
}

function projectedLogs(data: unknown) {
  return data as {
    lines: string[];
    logs: string;
    truncated: boolean;
    logProjection: Record<string, {
      originalLineCount: number;
      retainedRanges: Array<{ startLine: number; endLine: number }>;
      partialLineNumbers?: number[];
    }>;
  };
}

function assertRanges(data: unknown, original: string[], key = 'lines') {
  const projected = projectedLogs(data);
  const metadata = projected.logProjection[key]!;
  assert.equal(metadata.originalLineCount, original.length);
  const retained = metadata.retainedRanges.flatMap(({ startLine, endLine }) => original.slice(startLine - 1, endLine));
  assert.deepEqual(key === 'lines' ? projected.lines : projected.logs.split('\n'), retained);
}

describe('fault-focused evidence projection', () => {
  it('keeps the real 197-line DataAsset fault at line 133 in the investigation view', () => {
    assert.equal(realLogs.data.lines.length, 197);
    assert.match(realLogs.data.lines[132]!, /异常信息:Real DataAsset lab fault injection/);
    assert.equal(realLogs.data.lines.some((line) => line.includes('Caused by:')), false);
    const store = createEventStore(':memory:');
    try {
      const context = buildInvestigationContext(
        { ...incident(), last_seen: realLogs.eventTime }, [logEvidence(realLogs.data)], store,
      );
      const data = projectedLogs(context.evidence[0]?.data);
      assert.ok(data.lines.includes(realLogs.data.lines[132]!));
      assert.ok(data.lines.includes(realLogs.data.lines[133]!));
      assert.ok(data.lines.includes(realLogs.data.lines[134]!));
      assert.ok(data.lines.length <= 20);
      assert.equal(data.truncated, true);
      assertRanges(data, realLogs.data.lines);
      assert.deepEqual(context.truncation, {
        droppedEvidenceIds: [], truncatedItems: ['fault-logs'],
      });
      assert.ok(jsonBytes(context.evidence[0]?.data) <= 4096);
      assert.equal(realLogs.data.truncated, false);
    } finally {
      store.close();
    }
  });

  it('keeps multiple exception heads, distant cause chains and business frames instead of framework noise', () => {
    const lines = [
      ...Array.from({ length: 30 }, () => '\tat org.springframework.web.Dispatcher.dispatch(Web.java:10)'),
      '2026-08-20T10:30:00.000Z ERROR request failed',
      'java.lang.IllegalStateException: first fault',
      '\tat com.example.orders.OrderService.submit(OrderService.java:42)',
      ...Array.from({ length: 30 }, () => '\tat java.base/java.lang.Thread.run(Thread.java:1)'),
      'Caused by: java.io.IOException: downstream closed',
      '\tat com.example.client.Client.send(Client.java:9)',
      ...Array.from({ length: 30 }, () => '\tat org.apache.tomcat.Server.run(Server.java:1)'),
      'Caused by: java.net.SocketException: reset',
      '2026-08-20T10:30:01.000Z ERROR second request',
      'java.lang.IllegalArgumentException: second fault',
      '\tat com.example.orders.Validator.check(Validator.java:7)',
    ];
    const data = projectedLogs(buildIncidentContext(incident(), [logEvidence({ lines, truncated: false })], BOUNDS).evidence[0]?.data);
    for (const required of lines.filter((line) => /ERROR|Exception:|com.example/.test(line))) {
      assert.ok(data.lines.includes(required), required);
    }
    assertRanges(data, lines);
    assert.ok(data.lines.length <= 20);
    assert.equal(data.truncated, true);
  });

  it('prefers lines near the incident time even without an exception and preserves string logs', () => {
    const lines = Array.from({ length: 60 }, (_, index) =>
      `2026-08-20T10:${index.toString().padStart(2, '0')}:00.000Z INFO sample ${index}`);
    const context = buildIncidentContext(incident(), [logEvidence({ logs: lines.join('\n') })], { ...BOUNDS, maxLogLines: 5 });
    const data = projectedLogs(context.evidence[0]?.data);
    assert.ok(data.logs.includes('INFO sample 30'));
    assert.equal(data.logs.split('\n').length, 5);
    assert.equal(data.truncated, true);
    assertRanges(data, lines, 'logs');
  });

  it('progressively trims oversized fields without replacing the entire evidence item', () => {
    const raw = {
      lines: realLogs.data.lines,
      metadata: { note: '诊断'.repeat(8000), state: 'running' },
      samples: Array.from({ length: 100 }, (_, index) => ({ index, payload: 'x'.repeat(200) })),
      password: 'never-expose-this',
    };
    const data = projectedLogs(buildIncidentContext(
      { ...incident(), last_seen: realLogs.eventTime }, [logEvidence(raw)], BOUNDS,
    ).evidence[0]?.data);
    assert.ok(data.lines?.includes(realLogs.data.lines[132]!));
    assert.ok(data.lines?.includes(realLogs.data.lines[134]!));
    assert.equal(data.truncated, true);
    assert.ok(jsonBytes(data) <= 4096);
    assert.ok(!JSON.stringify(data).includes('never-expose-this'));
    assertRanges(data, raw.lines);
    assert.equal(raw.metadata.note.length, 16000);
  });

  it('shrinks evidence sections before dropping an item under the total context budget', () => {
    const records = Array.from({ length: 3 }, (_, index) => ({
      ...evidence(`inspect-${index}`, 'docker.inspect', realLogs.eventTime),
      data: { State: { Running: true }, detail: 'x'.repeat(900) },
    }));
    const context = buildIncidentContext(incident(), records, { ...BOUNDS, maxContextBytes: 2400 });
    assert.equal(context.evidence.length, 3);
    assert.ok(jsonBytes(context) <= 2400);
    for (const item of context.evidence) {
      assert.equal((item.data as { State?: { Running: boolean } }).State?.Running, true);
    }
    assert.ok(context.truncation?.truncatedItems.length);
  });

  it('bounds wide records of scalar facts without clearing the whole item', () => {
    const facts = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`counter-${index}`, index]));
    const context = buildIncidentContext(incident(), [{ ...logEvidence(facts), kind: 'docker.inspect' }], BOUNDS);
    const data = context.evidence[0]?.data as Record<string, unknown>;
    assert.ok(jsonBytes(data) <= 4096);
    assert.equal(data.truncated, true);
    assert.ok(Object.keys(data).some((key) => key.startsWith('counter-')));
  });

  it('bounds huge individual lines in UTF-8 and records partial lines', () => {
    const data = projectedLogs(buildIncidentContext(incident(), [logEvidence({
      lines: ['java.lang.IllegalStateException: ' + '故障'.repeat(5000), 'Caused by: java.io.IOException: reset'],
    })], { ...BOUNDS, maxContextBytes: 2000 }).evidence[0]?.data);
    assert.equal(data.truncated, true);
    assert.match(data.lines[0]!, /java.lang.IllegalStateException:/);
    assert.ok(data.lines.includes('Caused by: java.io.IOException: reset'));
    assert.ok(jsonBytes(data) <= 1000);
    assert.deepEqual(data.logProjection.lines?.partialLineNumbers, [1]);
    assert.ok(!JSON.stringify(data).includes('�'));
  });

  it('preserves collection truncation and applies the line cap across both log fields', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line-${index}`);
    const data = projectedLogs(toRuntimeSafeEvidence(logEvidence({ lines, logs: lines.join('\n'), truncated: true }), 20).data);
    assert.ok(data.lines.length + data.logs.split('\n').filter(Boolean).length <= 20);
    assert.equal(data.truncated, true);
    assertRanges(data, lines);
    assertRanges(data, lines, 'logs');
    const small = projectedLogs(toRuntimeSafeEvidence(logEvidence({ lines: ['one'], truncated: true }), 20).data);
    assert.equal(small.truncated, true);
    assertRanges(small, ['one']);
  });
});

describe('incident context evidence freshness', () => {
  it('many jfr.signal rows do not starve docker.stats and host.load', () => {
    const jfr = Array.from({ length: 10 }, (_, index) => evidence(
      `jfr-${String(index).padStart(2, '0')}`,
      'jfr.signal',
      `2026-08-20T12:00:${String(index).padStart(2, '0')}.000Z`,
    ));
    const stats = evidence('evd-docker-stats', 'docker.stats', '2026-08-20T11:00:00.000Z');
    const load = evidence('evd-host-load', 'host.load', '2026-08-20T11:00:01.000Z');
    const context = buildIncidentContext(incident(), [...jfr, stats, load], {
      maxEvidenceItems: 8,
      maxContextBytes: 8192,
      maxLogLines: 20,
    });
    const kinds = context.evidence.map((item) => item.kind);
    const ids = context.evidence.map((item) => item.id);
    assert.ok(kinds.includes('jfr.signal'));
    assert.ok(ids.includes('evd-docker-stats'));
    assert.ok(ids.includes('evd-host-load'));
    assert.ok(context.evidence.length <= 8);
  });

  it('prefers newer collectedAt before id when rank is equal', () => {
    const older = evidence('evd-zzz', 'host.memory', '2026-08-20T10:00:00.000Z');
    const newer = evidence('evd-aaa', 'host.memory', '2026-08-20T10:30:00.000Z');
    const context = buildIncidentContext(incident(), [older, newer], {
      maxEvidenceItems: 1,
      maxContextBytes: 8192,
      maxLogLines: 20,
    });
    assert.deepEqual(context.evidence.map((item) => item.id), ['evd-aaa']);
    assert.equal(context.truncation?.droppedEvidenceIds[0], 'evd-zzz');
  });
});
