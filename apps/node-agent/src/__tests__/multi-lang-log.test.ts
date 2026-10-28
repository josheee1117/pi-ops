import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeDockerLogs } from '../evidence/docker.js';
import { scanContainerLog } from '../events/log-events.js';

export const SOURCE = { container: 'log-drill', nodeId: 'local-dev', service: 'log-drill' };
export const TIME = '2026-10-26T19:30:01.123456789Z';
export function stamped(lines: readonly string[]): string[] {
  return lines.map((line, index) => `${TIME.slice(0, -10)}${String(123456789 + index).padStart(9, '0')}Z ${line}`);
}
export function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
export function python(exception = 'ValueError: broken'): string[] {
  return ['Traceback (most recent call last):', '  File "worker.py", line 7, in run', '    allocate()', exception];
}
export const FATAL_CASES = [
  { name: 'python-memory', runtime: 'python', type: 'runtime.oom', lines: python('MemoryError') },
  { name: 'python-recursion', runtime: 'python', type: 'runtime.stack_overflow', lines: python('RecursionError: maximum recursion depth exceeded') },
  { name: 'node-memory', runtime: 'node', type: 'runtime.oom', lines: ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', ' 1: 0xabc node::Abort()'] },
  { name: 'node-recursion', runtime: 'node', type: 'runtime.stack_overflow', lines: ['RangeError: Maximum call stack size exceeded', '    at recurse (/app/worker.js:7:3)'] },
];

describe('multi-language log contract', () => {
  for (const fixture of FATAL_CASES) {
    it(`recognizes ${fixture.name} with Docker time and its own runtime`, () => {
      const events = scanContainerLog(stamped(fixture.lines), SOURCE, false);
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.equal(event.type, fixture.type);
      assert.equal(event.severity, 'critical');
      assert.equal(event.source, 'docker');
      assert.equal(event.time, TIME);
      assert.equal(event.attributes['runtime'], fixture.runtime);
      assert.equal(event.attributes['containerName'], SOURCE.container);
      assert.equal(event.attributes['observedVia'], 'docker.logs');
      assert.equal(event.attributes['stackTrace'], fixture.lines.join('\n'));
      assert.equal(event.attributes['exceptionStackTrace'], undefined);
      assert.equal(event.attributes['businessCode'], undefined);
      assert.equal(event.attributes['logEpisode'], undefined);
    });
  }

  for (const head of ['TypeError: broken', 'Error: broken', 'failed Error: broken']) {
    it(`claims one Node record for ${head}`, () => {
      const lines = ['ERROR request failed', head, '    at run /app/worker.js:7:3'];
      const events = scanContainerLog(stamped(lines), SOURCE, false);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.attributes['module'], head.startsWith('Type') ? 'TypeError' : 'Error');
      assert.equal(events[0]!.attributes['businessCode'], 'UNHANDLED_EXCEPTION');
      assert.equal(events[0]!.attributes['logEpisode'], true);
      assert.equal(events[0]!.attributes['stackTrace'], lines.join('\n'));
      assert.equal(events[0]!.time, TIME);
    });
  }

  it('claims the preceding logger.exception ERROR despite different per-line timestamps', () => {
    const lines = ['2026-10-27 03:30:01,111 ERROR    37 request failed', ...python('pymysql.err.OperationalError: Lost connection to MySQL')];
    const events = scanContainerLog(stamped(lines), SOURCE, false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.attributes['module'], 'pymysql.err.OperationalError');
    assert.equal(events[0]!.attributes['stackTrace'], lines.join('\n'));
    assert.equal(events[0]!.time, TIME);
  });

  it('claims chained Python exceptions once without hiding a fatal inner or outer error', () => {
    for (const [first, last] of [['MemoryError', 'RuntimeError: wrapper'], ['ValueError: cause', 'MemoryError']]) {
      const lines = [...python(first), '', 'The above exception was the direct cause of the following exception:', '', ...python(last)];
      const events = scanContainerLog(stamped(lines), SOURCE, false);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'runtime.oom');
      assert.equal(events[0]!.attributes['exceptionClass'], last!.split(':')[0]);
      assert.equal(events[0]!.attributes['outerExceptionClass'], first!.split(':')[0]);
    }
  });

  it('does not read fatal text out of documentation, quoted text or Node JSON', () => {
    const lines = [
      'INFO docs: MemoryError RecursionError: maximum recursion depth exceeded',
      'INFO says FATAL ERROR: JavaScript heap out of memory',
      'INFO "RangeError: Maximum call stack size exceeded"',
      JSON.stringify({ level: 'error', msg: 'failed', stack: 'RangeError: Maximum call stack size exceeded\n    at run (/app/a.js:1:1)' }),
      'WARNING load_user from jwt got exception MemoryError',
    ];
    const events = scanContainerLog(stamped(lines), SOURCE, false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'business.error');
    assert.equal(events[0]!.attributes['businessCode'], 'LOG_ERROR');
    assert.equal(events[0]!.attributes['logEpisode'], true);
  });

  it('keeps stdout blocks intact when stderr interleaves and never borrows its ERROR', () => {
    const input = stamped(python('MemoryError'));
    const raw = Buffer.concat([
      frame(1, `${input[0]}\n${input[1]}\n`),
      frame(2, `${TIME} ERROR separate failure\n`),
      frame(1, `${input[2]}\n${input[3]}\n`),
    ]);
    const decoded = decodeDockerLogs(raw, 65536, 200);
    assert.ok('records' in decoded, 'decoder must retain stream and nanosecond time');
    const events = scanContainerLog(decoded.records, SOURCE, false);
    assert.equal(events.length, 2);
    const fatal = events.find((event) => event.type === 'runtime.oom')!;
    assert.equal(fatal.attributes['stackTrace'], python('MemoryError').join('\n'));
  });

  it('keeps fault identity separate from message templates and does not truncate the key', () => {
    const exceptionA = scanContainerLog(stamped(python("pymysql.err.OperationalError: Can't connect to MySQL")), SOURCE, false)[0]!;
    const exceptionB = scanContainerLog(stamped(python('pymysql.err.OperationalError: Lost connection to MySQL')), SOURCE, false)[0]!;
    assert.equal(exceptionA.attributes['module'], exceptionB.attributes['module']);
    const keys = ['mysql', 'redis'].map((dependency) => scanContainerLog(stamped([`ERROR pkg.${dependency} connection refused`]), SOURCE, false)[0]!.attributes['module']);
    assert.notEqual(keys[0], keys[1]);
    const long = 'x'.repeat(600);
    const tails = ['alpha', 'beta'].map((tail) => scanContainerLog(stamped([`ERROR 37 ${long} ${tail}`]), SOURCE, false)[0]!.attributes['module']);
    assert.notEqual(tails[0], tails[1]);
    assert.ok(String(tails[0]).length > 600);
    const pidA = scanContainerLog(stamped(['2026-10-27 03:30:01,111 ERROR 37 DB failed 123']), SOURCE, false)[0]!;
    const pidB = scanContainerLog(stamped(['2026-10-27 03:30:01,111 ERROR 44 DB failed 456']), SOURCE, false)[0]!;
    assert.equal(pidA.attributes['module'], pidB.attributes['module']);
    assert.equal(pidA.attributes['module'], 'DB failed <number>');
  });

  it('coalesces one template per batch with a log record count, without merging different dependencies', () => {
    const events = scanContainerLog(stamped([
      'ERROR pkg.mysql failed for "alice" at 10.0.0.1 id 123',
      'ERROR pkg.mysql failed for "bob" at 10.0.0.2 id 456',
      'ERROR pkg.redis failed for "bob" at 10.0.0.2 id 456',
    ]), SOURCE, false);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.attributes['logRecordCount'], 2);
    assert.equal(events[1]!.attributes['logRecordCount'], 1);
  });

  it('keeps a raw event id stable as stack frames or count change', () => {
    const lines = stamped(['TypeError: broken', '    at run (/app/worker.js:7:3)']);
    const first = scanContainerLog(lines, SOURCE, false)[0]!;
    const extended = scanContainerLog([...lines, `${TIME}     at next (/app/worker.js:8:3)`], SOURCE, false)[0]!;
    assert.equal(first.id, extended.id);
  });

  it('recognizes timestamp-prefixed Java ordinary, OOM and overflow, without logEpisode', () => {
    for (const [clazz, type] of [['java.lang.IllegalStateException', 'business.error'], ['java.lang.OutOfMemoryError', 'jvm.oom'], ['java.lang.StackOverflowError', 'jvm.stack_overflow']]) {
      const events = scanContainerLog(stamped([`${clazz}: broken`, '\tat Worker.run(Worker.java:7)']), SOURCE, false);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, type);
      assert.equal(events[0]!.time, TIME);
      assert.equal(events[0]!.attributes['logEpisode'], undefined);
      assert.ok(String(events[0]!.attributes['stackTrace']).includes('\tat Worker.run'));
    }
  });

  it('does not promote Java fatal mentions in documentation, messages or JSON to events', () => {
    for (const clazz of ['java.lang.OutOfMemoryError', 'java.lang.StackOverflowError']) {
      for (const body of [`docs: ${clazz}: Java heap space`, `INFO guide mentions ${clazz}`, JSON.stringify({ message: `failed ${clazz}: heap space` })]) {
        assert.deepEqual(scanContainerLog(stamped([body]), SOURCE, false), [], body);
      }
      const events = scanContainerLog(stamped([`ERROR docs: ${clazz}: heap space`]), SOURCE, false);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.attributes['businessCode'], 'LOG_ERROR');
      assert.equal(events[0]!.type, 'business.error');
    }
  });

  it('claims the ERROR preceding a Java stack as one record', () => {
    const lines = ['ERROR request failed', 'java.lang.IllegalStateException: broken', '\tat Worker.run(Worker.java:7)'];
    const events = scanContainerLog(stamped(lines), SOURCE, false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.attributes['stackTrace'], lines.join('\n'));
    assert.equal(events[0]!.attributes['logEpisode'], undefined);
  });

  it('preserves Java fatal headers printed by an uncaught main thread or prefixed logger', () => {
    for (const head of ['Exception in thread "main" java.lang.OutOfMemoryError: heap space', '2026-10-27 03:30:01 ERROR 1 worker: java.lang.OutOfMemoryError: heap space']) {
      const events = scanContainerLog(stamped([head, '\tat Worker.run(Worker.java:7)']), SOURCE, false);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'jvm.oom');
    }
    assert.equal(scanContainerLog(stamped(['Exception in thread "main" java.lang.OutOfMemoryError: heap space']), SOURCE, false)[0]!.type, 'jvm.oom');
  });

  it('preserves JFR payload time and suppresses the earlier raw fatal', () => {
    const payloadTime = '2026-10-20T01:02:03.987654321Z';
    const lines = stamped(['java.lang.OutOfMemoryError: heap space', '\tat Worker.run(Worker.java:7)', `[PI_OPS_JFR] ${JSON.stringify({ type: 'JVM_OOM', timestamp: payloadTime, attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionStackTrace: 'at Worker.run(Worker.java:7)' } })}`]);
    const events = scanContainerLog(lines, SOURCE, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.time, payloadTime);
    assert.equal(events[0]!.source, 'application');
    assert.equal(events[0]!.attributes['stackTrace'], 'at Worker.run(Worker.java:7)');
    assert.equal(events[0]!.attributes['exceptionStackTrace'], undefined);
  });

  it('instrumentation suppresses ordinary raw exceptions but not raw Python/Node fatal evidence', () => {
    assert.deepEqual(scanContainerLog(stamped(python()), SOURCE, true), []);
    for (const fixture of FATAL_CASES) assert.equal(scanContainerLog(stamped(fixture.lines), SOURCE, true).length, 1);
  });
});
