import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { OpsEvent } from '@pi-ops/protocol';
import { dockerLogRecord, type DockerLogRecord } from '../evidence/docker.js';
import { scanContainerLog } from '../events/log-events.js';

export const FIXTURE_ROOT = new URL('../../../../test/fixtures/log-scan/', import.meta.url);
export function replayGroups(): Record<string, OpsEvent[]> {
  const samples = new Map<string, DockerLogRecord[]>();
  for (const text of readFileSync(new URL('ragflow-samples-20261027.jsonl', FIXTURE_ROOT), 'utf-8').trim().split('\n')) {
    const row: unknown = JSON.parse(text);
    assert.ok(row && typeof row === 'object' && 'sample' in row && 'stream' in row && 'line' in row);
    assert.equal(typeof row.sample, 'string');
    assert.equal(typeof row.line, 'string');
    assert.ok(row.stream === 'stdout' || row.stream === 'stderr');
    if (typeof row.sample !== 'string' || typeof row.line !== 'string') throw new Error('invalid sample');
    const records = samples.get(row.sample) ?? [];
    records.push(dockerLogRecord(row.line, row.stream));
    samples.set(row.sample, records);
  }
  const groups: Record<string, OpsEvent[]> = {};
  for (const [name, records] of samples) groups[name] = scanContainerLog(records, { container: 'ragflow', nodeId: 'local-dev', service: 'ragflow' }, false);
  const cases: Record<string, string[]> = {
    'python-oom': ['Traceback (most recent call last):', '  File "worker.py", line 7, in run', '    allocate()', 'MemoryError'],
    'python-stack-overflow': ['Traceback (most recent call last):', '  File "worker.py", line 7, in run', '    recurse()', 'RecursionError: maximum recursion depth exceeded'],
    'node-oom': ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    'node-stack-overflow': ['RangeError: Maximum call stack size exceeded', '    at recurse (/app/worker.js:7:3)'],
    'python-ordinary': ['ERROR request failed', 'Traceback (most recent call last):', '  File "worker.py", line 7, in run', '    connect()', "pymysql.err.OperationalError: Lost connection to MySQL server during query"],
    'node-ordinary': ['failed TypeError: broken', '    at run /app/worker.js:7:3'],
    'node-json': [JSON.stringify({ level: 'error', msg: 'request failed', stack: 'RangeError: Maximum call stack size exceeded\n    at run (/app/a.js:1:1)' })],
    'java-fatal-mentions': ['docs: java.lang.OutOfMemoryError: Java heap space', 'INFO guide mentions java.lang.StackOverflowError', JSON.stringify({ message: 'failed java.lang.OutOfMemoryError: heap space' })],
    'python-chain': ['Traceback (most recent call last):', '  File "worker.py", line 7, in run', 'MemoryError', '', 'During handling of the above exception, another exception occurred:', '', 'Traceback (most recent call last):', '  File "worker.py", line 9, in run', 'RuntimeError: wrapper'],
  };
  for (const [name, lines] of Object.entries(cases)) {
    groups[name] = scanContainerLog(lines.map((body, i) => `2026-10-26T19:30:01.${String(123456789 + i)}Z ${body}`), { container: 'log-drill', nodeId: 'local-dev', service: 'log-drill' }, false);
  }
  return groups;
}

describe('sanitized ragflow replay and shared event contract', () => {
  it('coalesces the 0330 window by template and keeps Docker time rather than Beijing app time', () => {
    const groups = replayGroups();
    const events = groups['0330-window']!;
    assert.ok(events.length > 0);
    assert.ok(events.some((event) => event.attributes['businessCode'] === 'UNHANDLED_EXCEPTION'));
    assert.ok(events.some((event) => Number(event.attributes['logRecordCount']) > 1));
    assert.ok(events.every((event) => event.time.startsWith('2026-10-26T19:30:')));
    const templates = events.map((event) => JSON.stringify([event.type, event.attributes['module']]));
    assert.equal(new Set(templates).size, templates.length);
    assert.ok(events.every((event) => !/\b(?:35|37)\b/.test(String(event.attributes['module']))));
    assert.deepEqual(groups['jwt-warning-noise'], []);
    assert.deepEqual(groups['java-fatal-mentions'], []);
    assert.equal(groups['doc-owner-rejection']!.length, 1);
    assert.equal(groups['doc-owner-rejection']![0]!.attributes['logRecordCount'], 3);
  });

  it('matches the committed scanner output used by the center, field for field', () => {
    const expected: unknown = JSON.parse(readFileSync(new URL('node-agent-events.json', FIXTURE_ROOT), 'utf-8'));
    assert.deepEqual(expected, { groups: replayGroups() });
    for (const events of Object.values(replayGroups())) for (const event of events) {
      assert.equal(typeof event.attributes['containerName'], 'string');
      assert.equal(typeof event.attributes['stackTrace'], 'string');
      assert.equal(event.attributes['exceptionStackTrace'], undefined);
      assert.ok(Number(event.attributes['logRecordCount']) > 0);
    }
  });
});
