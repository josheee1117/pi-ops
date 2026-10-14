import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasJfrPayload, operationModule, scanContainerLog } from '../events/log-events.js';

const SOURCE = { container: 'rdl-dataasset-6dfb8e88', nodeId: 'node-1', service: 'rdl-dataasset-6dfb8e88' };

// Captured verbatim from the lab container's stdout.
const REAL_JFR_LINE =
  '2026-10-12 08:02:00.031  INFO 1 --- [ Event Stream 1] com.mbkj.piops.jfr.JfrEventLogger        : '
  + '[PI_OPS_JFR] {"schemaVersion":"1.0","type":"BUSINESS_ERROR","timestamp":"2026-10-12T08:02:00.029598709Z",'
  + '"service":"rdl-dataasset-6dfb8e88","threadName":"http-nio-0.0.0.0-28189-exec-1","durationMs":0,'
  + '"attributes":{"businessType":"http","operation":"GET /auth/lab/server-fault",'
  + '"errorCode":"UNHANDLED_EXCEPTION","errorCategory":"PROCESSING","safeMessage":"Unhandled request exception",'
  + '"module":"/auth/lab/server-fault","exceptionClass":"java.lang.IllegalStateException",'
  + '"exceptionStackTrace":"at com.mbkj.dap.lab.LabFaultController.serverFault(LabFaultController.java:15)",'
  + '"responseStatus":500},"stackTrace":[]}';

describe('operationModule', () => {
  it('extracts the route from a method and path', () => {
    assert.equal(operationModule('GET /auth/lab/server-fault'), '/auth/lab/server-fault');
  });

  it('returns a bare path unchanged', () => {
    assert.equal(operationModule('/auth/info'), '/auth/info');
  });
});

describe('hasJfrPayload', () => {
  it('detects the starter payload prefix', () => {
    assert.equal(hasJfrPayload([REAL_JFR_LINE]), true);
  });

  it('is false for ordinary application logs', () => {
    assert.equal(hasJfrPayload(['2026-10-12 08:00:00 INFO 1 --- Started DataAssetApplication']), false);
  });
});

describe('scanContainerLog: JFR payload recovery', () => {
  it('recovers the JFR event with the identity the sender path uses', () => {
    const events = scanContainerLog([REAL_JFR_LINE], SOURCE, false);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.source, 'application');
    assert.equal(event.type, 'business.error');
    assert.equal(event.severity, 'error');
    assert.equal(event.time, '2026-10-12T08:02:00.029598709Z');
    assert.equal(event.message, 'Unhandled request exception');
    assert.equal(event.nodeId, 'node-1');
  });

  it('sets both errorCode and businessCode so the fingerprint matches the sender path', () => {
    const event = scanContainerLog([REAL_JFR_LINE], SOURCE, false)[0]!;
    assert.equal(event.attributes['errorCode'], 'UNHANDLED_EXCEPTION');
    assert.equal(event.attributes['businessCode'], 'UNHANDLED_EXCEPTION');
    assert.equal(event.attributes['module'], '/auth/lab/server-fault');
  });

  it('marks provenance without claiming a JFR file', () => {
    const event = scanContainerLog([REAL_JFR_LINE], SOURCE, false)[0]!;
    assert.equal(event.attributes['observedVia'], 'docker.logs');
    assert.equal(event.attributes['producer'], 'pi-ops-jfr');
    assert.equal(event.attributes['containerName'], 'rdl-dataasset-6dfb8e88');
  });

  it('preserves responseStatus as integer from payload attributes', () => {
    const event = scanContainerLog([REAL_JFR_LINE], SOURCE, false)[0]!;
    assert.equal(event.attributes['responseStatus'], 500);
  });

  it('ignores telemetry payload types instead of forwarding them', () => {
    const cpu =
      '2026-10-12 08:07:13.267  INFO 1 --- [ Event Stream 1] com.mbkj.piops.jfr.JfrEventLogger        : '
      + '[PI_OPS_JFR] {"schemaVersion":"1.0","type":"JVM_CPU","timestamp":"2026-10-12T08:07:13.190Z",'
      + '"attributes":{"jvmUser":0.003},"stackTrace":[]}';
    assert.equal(scanContainerLog([cpu], SOURCE, false).length, 0);
  });

  it('ignores a malformed payload without throwing', () => {
    const broken = '2026-10-12 08:00:00 INFO 1 --- x : [PI_OPS_JFR] {"type":"BUSINESS_ERROR","attributes":';
    assert.deepEqual(scanContainerLog([broken], SOURCE, false), []);
  });
});

describe('scanContainerLog: JVM fatal errors', () => {
  it('reports heap OOM from a plain stack as critical', () => {
    const lines = [
      '2026-10-12 08:10:00.000 ERROR 1 --- [nio-8080-exec-1] c.e.Handler : failed to allocate',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Worker.allocate(Worker.java:42)',
      '\tat com.example.Worker.run(Worker.java:11)',
    ];
    const events = scanContainerLog(lines, SOURCE, false);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, 'jvm.oom');
    assert.equal(event.severity, 'critical');
    assert.equal(event.source, 'docker');
    assert.equal(event.attributes['exceptionClass'], 'java.lang.OutOfMemoryError');
    assert.equal(event.attributes['exceptionMessage'], 'Java heap space');
    assert.equal(
      event.attributes['stackTrace'],
      'at com.example.Worker.allocate(Worker.java:42)\nat com.example.Worker.run(Worker.java:11)',
    );
  });

  it('reports stack overflow as its own type', () => {
    const lines = [
      'java.lang.StackOverflowError',
      '\tat com.example.Recurse.down(Recurse.java:7)',
      '\tat com.example.Recurse.down(Recurse.java:7)',
    ];
    const events = scanContainerLog(lines, SOURCE, false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'jvm.stack_overflow');
    assert.equal(events[0]!.severity, 'critical');
    assert.equal(events[0]!.attributes['exceptionClass'], 'java.lang.StackOverflowError');
  });

  it('isolates event IDs between containers on the same node', () => {
    const lines = [
      '2026-10-12 08:10:00.000 ERROR 1 --- [nio-8080-exec-1] c.e.Handler : failed to allocate',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Worker.allocate(Worker.java:42)',
    ];
    const sourceA = { container: 'container-a', nodeId: 'node-1', service: 'container-a' };
    const sourceB = { container: 'container-b', nodeId: 'node-1', service: 'container-b' };
    const eventA = scanContainerLog(lines, sourceA, false)[0]!;
    const eventB = scanContainerLog(lines, sourceB, false)[0]!;
    assert.notEqual(eventA.id, eventB.id);
  });

  it('keeps event ID and time stable when re-scanning timestamped lines', () => {
    const lines = [
      '2026-10-12 08:10:00.000 ERROR 1 --- [nio-8080-exec-1] c.e.Handler : failed to allocate',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Worker.allocate(Worker.java:42)',
    ];
    const first = scanContainerLog(lines, SOURCE, false)[0]!;
    const second = scanContainerLog(lines, SOURCE, false)[0]!;
    assert.equal(first.id, second.id);
    assert.equal(first.time, second.time);
  });
});

describe('scanContainerLog: generic uncaught exception', () => {
  const lines = [
    '2026-10-12 08:20:00.000 ERROR 1 --- [nio-8080-exec-2] c.e.A : boom',
    'java.lang.IllegalStateException: something broke',
    '\tat com.example.Service.handle(Service.java:88)',
  ];

  it('reports an uninstrumented app exception as business.error', () => {
    const events = scanContainerLog(lines, SOURCE, false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'business.error');
    assert.equal(events[0]!.source, 'docker');
    assert.equal(events[0]!.attributes['exceptionClass'], 'java.lang.IllegalStateException');
    assert.equal(events[0]!.attributes['module'], 'java.lang.IllegalStateException');
  });

  it('stays silent once the container is known to carry JFR payloads', () => {
    assert.deepEqual(scanContainerLog(lines, SOURCE, true), []);
  });

  it('still reads fatal errors from raw stacks on an instrumented container', () => {
    const instrumented = [
      '[PI_OPS_JFR] {"type":"JVM_CPU","attributes":{}}',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Worker.allocate(Worker.java:42)',
    ];
    const events = scanContainerLog(instrumented, SOURCE, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'jvm.oom');
  });

  it('does not re-report a fatal error that a payload already carried', () => {
    const lines = [
      '[PI_OPS_JFR] {"type":"BUSINESS_ERROR","timestamp":"2026-10-12T09:00:00.000Z","attributes":{'
      + '"errorCode":"UNHANDLED_EXCEPTION","module":"/auth/lab/heap-oom",'
      + '"exceptionClass":"java.lang.OutOfMemoryError"}}',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Leak.fill(Leak.java:9)',
    ];
    const events = scanContainerLog(lines, SOURCE, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'jvm.oom');
    assert.equal(events[0]!.source, 'application');
  });

  it('suppresses raw fatal error when JFR payload appears later in the same scan', () => {
    const reverseOrder = [
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Leak.fill(Leak.java:9)',
      '[PI_OPS_JFR] {"type":"BUSINESS_ERROR","timestamp":"2026-10-12T09:00:00.000Z","attributes":{'
      + '"errorCode":"UNHANDLED_EXCEPTION","module":"/auth/lab/heap-oom",'
      + '"exceptionClass":"java.lang.OutOfMemoryError"}}',
    ];
    const events = scanContainerLog(reverseOrder, SOURCE, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'jvm.oom');
    assert.equal(events[0]!.source, 'application');
  });

  it('suppresses raw fatal error across scan batches via recentFatal', () => {
    const rawOnly = [
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat com.example.Leak.fill(Leak.java:9)',
    ];
    const recentFatal = new Set(['java.lang.OutOfMemoryError']);
    const events = scanContainerLog(rawOnly, SOURCE, true, recentFatal);
    assert.equal(events.length, 0);
  });

  it('reclassifies a JVM Error recorded through the business-error recorder', () => {
    const oomPayload =
      '[PI_OPS_JFR] {"type":"BUSINESS_ERROR","timestamp":"2026-10-12T09:00:00.000Z","attributes":{'
      + '"errorCode":"UNHANDLED_EXCEPTION","safeMessage":"Unhandled request exception",'
      + '"module":"/auth/lab/heap-oom","exceptionClass":"java.lang.OutOfMemoryError",'
      + '"exceptionStackTrace":"at com.example.Leak.fill(Leak.java:9)"}}';
    const events = scanContainerLog([oomPayload], SOURCE, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'jvm.oom');
    assert.equal(events[0]!.severity, 'critical');

    const overflowPayload = oomPayload
      .replace('java.lang.OutOfMemoryError', 'java.lang.StackOverflowError')
      .replace('/auth/lab/heap-oom', '/auth/lab/stack-overflow');
    const overflow = scanContainerLog([overflowPayload], SOURCE, true);
    assert.equal(overflow[0]!.type, 'jvm.stack_overflow');
  });
});

describe('scanContainerLog: no false positives', () => {
  it('ignores ordinary startup and request logs', () => {
    const lines = [
      '2026-10-12 08:00:00.000  INFO 1 --- [main] c.m.d.DataAssetApplication : Started in 8.7 seconds',
      '2026-10-12 08:00:01.000  INFO 1 --- [nio-8080-exec-1] c.m.d.AuthFilter : request accepted',
      '2026-10-12 08:00:02.000  WARN 1 --- [nio-8080-exec-2] c.m.d.Cache : cache miss',
    ];
    assert.deepEqual(scanContainerLog(lines, SOURCE, false), []);
  });

  it('ignores an exception line with no stack frames', () => {
    const lines = ['c.e.A : suppressed java.lang.IllegalStateException while closing'];
    assert.deepEqual(scanContainerLog(lines, SOURCE, false), []);
  });
});
