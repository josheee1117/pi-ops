import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpsEvent } from '@pi-ops/protocol';
import { createLogDetector } from '../detectors/logs.js';
import { createApp } from '../app.js';
import { makeNodeAgentConfig } from './test-config.js';

const START = Date.parse('2026-10-26T19:30:01Z');
function line(text: string, tick = 0): string {
  return `${new Date(START + tick).toISOString()} ${text}`;
}
function driver(batches: Array<{ lines: string[]; truncated?: boolean }>, overrides: Parameters<typeof makeNodeAgentConfig>[0] = {}) {
  const events: OpsEvent[] = [];
  let accept = true;
  let now = START;
  let id = 'container-one';
  const config = makeNodeAgentConfig({ allowedContainers: new Set(['log-drill']), ...overrides });
  const detector = createLogDetector(config, {
    enqueue(event) { if (!accept) return false; events.push(event); return true; },
    droppedCount: () => 0, start() {}, async stop() {}, queueDepth: () => 0,
  }, {
    fetchLogs: async () => {
      const batch = batches.shift() ?? { lines: [] };
      return { buffer: Buffer.from(batch.lines.join('\n')), truncated: batch.truncated ?? false };
    },
    fetchContainerId: async () => id,
    now: () => now,
  });
  return { detector, config, events, accept(value: boolean) { accept = value; }, advance(ms: number) { now += ms; }, replace() { id = 'container-two'; } };
}

describe('log scan boundaries and delivery', () => {
  it('joins a Python traceback over polls, removes overlap and clears a completed block', async () => {
    const head = [line('ERROR 37 request failed'), line('Traceback (most recent call last):', 1), line('  File "worker.py", line 7, in run', 2)];
    const tail = [line('    allocate()', 3), line('MemoryError', 4), line('INFO done', 5)];
    const d = driver([{ lines: head }, { lines: [...head, ...tail] }, { lines: [...head, ...tail] }, { lines: [line('    stale()', 5), line('MemoryError', 6)] }]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.type, 'runtime.oom');
    assert.equal(d.events[0]!.time, new Date(START).toISOString());
    await d.detector.pollOnce();
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
  });

  it('claims an ERROR at the previous poll boundary instead of sending it twice', async () => {
    const d = driver([{ lines: [line('ERROR request failed')] }, { lines: [line('Traceback (most recent call last):', 1), line('  File "x.py", line 1, in run', 2), line('MemoryError', 3), line('INFO done', 4)] }]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.type, 'runtime.oom');
    assert.equal(d.events[0]!.time, new Date(START).toISOString());
  });

  it('flushes a trailing standalone ERROR on the next poll even without new logs', async () => {
    const d = driver([{ lines: [line('ERROR standalone failed')] }, { lines: [] }]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.attributes['businessCode'], 'LOG_ERROR');
  });

  it('does not emit a repeated trailing ERROR before the next poll can attach its traceback', async () => {
    const d = driver([
      { lines: [line('ERROR request failed'), line('INFO next', 1), line('ERROR request failed', 2)] },
      { lines: [line('Traceback (most recent call last):', 3), line('  File "x.py", line 1, in run', 4), line('ValueError: broken', 5), line('INFO done', 6)] },
    ]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.attributes['logRecordCount'], 1);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 2);
    assert.equal(d.events[1]!.attributes['businessCode'], 'UNHANDLED_EXCEPTION');
    assert.ok(String(d.events[1]!.attributes['stackTrace']).startsWith('ERROR request failed\n'));
  });

  it('starts a fresh 60 second wait when one block ends and another starts', async () => {
    const d = driver([
      { lines: [line('Traceback (most recent call last):'), line('  File "x.py", line 1, in run', 1)] },
      { lines: [line('ValueError: first', 50000), line('INFO next', 50001), line('Traceback (most recent call last):', 50002)] },
      { lines: [line('  File "x.py", line 2, in run', 70000), line('MemoryError', 70001), line('INFO done', 70002)] },
    ]);
    await d.detector.pollOnce();
    d.advance(50000);
    await d.detector.pollOnce();
    d.advance(20000);
    await d.detector.pollOnce();
    assert.deepEqual(d.events.map((event) => event.type), ['business.error', 'runtime.oom']);
    assert.equal(d.detector.stats().unfinishedDropped, 0);
  });

  it('keeps a Python chain together when the chain separator arrives in the next poll', async () => {
    const d = driver([{ lines: [line('Traceback (most recent call last):'), line('  File "x.py", line 1, in run', 1), line('MemoryError', 2)] }, { lines: [line('During handling of the above exception, another exception occurred:', 3), line('Traceback (most recent call last):', 4), line('  File "x.py", line 2, in run', 5), line('RuntimeError: wrapper', 6), line('INFO done', 7)] }]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.type, 'runtime.oom');
    assert.equal(d.events[0]!.attributes['exceptionClass'], 'RuntimeError');
    assert.equal(d.events[0]!.attributes['outerExceptionClass'], 'MemoryError');
  });

  it('retains Node headers until frames arrive and does not require parentheses on V8 frames', async () => {
    const d = driver([{ lines: [line('failed TypeError: broken')] }, { lines: [line('    at run /app/a.js:7:3', 1)] }]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.attributes['module'], 'TypeError');
  });

  it('emits confirmed Node heap OOM immediately with stackIncomplete and never emits it again on continuation', async () => {
    const head = line('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');
    const d = driver([{ lines: [head] }, { lines: [head, line(' 1: 0xabc node::Abort()', 1)] }]);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.attributes['stackIncomplete'], true);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
  });

  it('counts unfinished drops at 60 seconds, 200 lines or 64 KiB, and never revives them', async () => {
    for (const extra of [[], Array.from({ length: 201 }, (_, i) => line('    frame()', i + 1)), [line(`    ${'x'.repeat(65536)}`, 1)]]) {
      const d = driver([{ lines: [line('Traceback (most recent call last):'), ...extra] }, { lines: [line('MemoryError', 300)] }], { logScanMaxLines: 2000, logsMaxBytes: 200000 });
      await d.detector.pollOnce();
      d.advance(60001);
      await d.detector.pollOnce();
      assert.equal(d.events.length, 0);
      assert.equal(d.detector.stats().unfinishedDropped, 1);
    }
  });

  it('ends an incomplete block on the next independent record', async () => {
    const d = driver([{ lines: [line('Traceback (most recent call last):'), line('  File "a.py", line 1, in run', 1)] }, { lines: [line('INFO next request', 2), line('MemoryError', 3)] }]);
    await d.detector.pollOnce();
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    assert.equal(d.detector.stats().unfinishedDropped, 1);
  });

  it('clears pending data and the since cursor on container replacement', async () => {
    const d = driver([{ lines: [line('Traceback (most recent call last):')] }, { lines: [line('MemoryError', 1), line('ERROR new container', 2), line('INFO done', 3)] }]);
    await d.detector.pollOnce();
    d.replace();
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.attributes['businessCode'], 'LOG_ERROR');
    assert.equal(d.detector.stats().unfinishedDropped, 1);
  });

  it('retries the failed event object after the log overlap has gone', async () => {
    const d = driver([{ lines: [line('ERROR failed once'), line('INFO done', 1)] }, { lines: [] }]);
    d.accept(false);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
    assert.equal(d.detector.stats().retryQueueDepth, 1);
    d.accept(true);
    d.advance(10000);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.time, new Date(START).toISOString());
    assert.equal(d.detector.stats().retryQueueDepth, 0);
  });

  it('limits retries to 100 events and five subsequent rounds, with visible dropped counters', async () => {
    const d = driver([{ lines: Array.from({ length: 103 }, (_, i) => line(`ERROR distinct_${String.fromCharCode(65 + i)} failed`, i)).concat(line('INFO done', 104)) }]);
    d.accept(false);
    await d.detector.pollOnce();
    assert.equal(d.detector.stats().retryQueueDepth, 100);
    assert.equal(d.detector.stats().retryDropped, 3);
    for (let i = 0; i < 5; i += 1) await d.detector.pollOnce();
    assert.equal(d.detector.stats().retryQueueDepth, 0);
    assert.equal(d.detector.stats().retryDropped, 103);
    d.accept(true);
    await d.detector.pollOnce();
    assert.equal(d.events.length, 0);
  });

  it('reports both line and byte truncation on the events and health endpoint', async () => {
    for (const overrides of [{ logScanMaxLines: 2 }, { logsMaxBytes: 100 }, {}]) {
      const d = driver([{ lines: Array.from({ length: 4 }, (_, i) => line(`ERROR pkg.a problem ${i}`, i)), truncated: Object.keys(overrides).length === 0 }], overrides);
      await d.detector.pollOnce();
      assert.equal(d.events.length, 1);
      assert.equal(d.events[0]!.attributes['collectionGap'], true);
      assert.equal(d.detector.stats().truncations, 1);
      const app = createApp(d.config, () => d.detector.stats());
      const response = await app.request('/health');
      const health = await response.json();
      assert.equal(health.logScan.truncations, 1);
      assert.equal(health.logScan.dropped, 0);
    }
  });

  it('keeps collectionGap on a block completed after a truncated poll', async () => {
    const d = driver([{ lines: [line('Traceback (most recent call last):'), line('  File "a.py", line 1, in run', 1), ''], truncated: true }, { lines: [line('MemoryError', 2), line('INFO done', 3)] }]);
    await d.detector.pollOnce();
    await d.detector.pollOnce();
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0]!.attributes['collectionGap'], true);
  });

  it('bounds a retained trailing ERROR line by 64 KiB as well', async () => {
    const d = driver([{ lines: [line(`ERROR ${'x'.repeat(65537)}`)] }], { logsMaxBytes: 200000 });
    await d.detector.pollOnce();
    assert.equal(d.detector.stats().unfinishedDropped, 1);
  });

  it('handles more than 2000 lines and many distinct templates without unbounded replay state', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => line(`ERROR template_${i.toString(36).replace(/\d/g, 'x')} failed ${i}`, i));
    const d = driver([{ lines }], { logScanMaxLines: 2000, logsMaxBytes: 500000 });
    await d.detector.pollOnce();
    assert.equal(d.detector.stats().truncations, 1);
    assert.ok(d.events.length > 100);
    assert.ok(d.events.length <= 2000);
    assert.ok(d.events.every((event) => event.attributes['collectionGap'] === true));
  });
});
