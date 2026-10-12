import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint } from '../fingerprint.js';

/**
 * One fault must yield one Incident. The Docker-log fallback recovers the same
 * JFR payload the sender path forwards, so both producers have to agree on the
 * fingerprint dimensions the Incident identity is built from.
 */
describe('computeFingerprint: sender path vs docker-log fallback', () => {
  const senderEvent = {
    source: 'application' as const,
    nodeId: 'rdl-6dfb8e88',
    service: 'rdl-dataasset-6dfb8e88',
    type: 'business.error',
    attributes: {
      errorCode: 'UNHANDLED_EXCEPTION',
      businessCode: 'UNHANDLED_EXCEPTION',
      module: '/auth/lab/server-fault',
      operation: 'GET /auth/lab/server-fault',
    },
  };

  it('is identical for a recovered log payload', () => {
    const logEvent = {
      source: 'application' as const,
      nodeId: 'rdl-6dfb8e88',
      service: 'rdl-dataasset-6dfb8e88',
      type: 'business.error',
      attributes: {
        errorCode: 'UNHANDLED_EXCEPTION',
        businessCode: 'UNHANDLED_EXCEPTION',
        module: '/auth/lab/server-fault',
        operation: 'GET /auth/lab/server-fault',
        observedVia: 'docker.logs',
        producer: 'pi-ops-jfr',
      },
    };
    assert.equal(computeFingerprint(logEvent), computeFingerprint(senderEvent));
  });

  it('ignores observation-only attributes', () => {
    // Provenance markers must not fork the identity of one fault.
    const base = computeFingerprint(senderEvent);
    const marked = computeFingerprint({
      ...senderEvent,
      attributes: { ...senderEvent.attributes, observedVia: 'docker.logs', containerName: 'x' },
    });
    assert.equal(marked, base);
  });

  it('separates business errors that differ in code or module', () => {
    const otherModule = computeFingerprint({
      ...senderEvent,
      attributes: { ...senderEvent.attributes, module: '/auth/other' },
    });
    const otherCode = computeFingerprint({
      ...senderEvent,
      attributes: { ...senderEvent.attributes, errorCode: 'VALIDATION', businessCode: 'VALIDATION' },
    });
    assert.notEqual(otherModule, computeFingerprint(senderEvent));
    assert.notEqual(otherCode, computeFingerprint(senderEvent));
  });

  it('keeps log-observed JVM errors distinct from application business errors', () => {
    const oom = computeFingerprint({
      source: 'docker',
      nodeId: 'node-1',
      service: 'app',
      type: 'jvm.oom',
      attributes: { exceptionClass: 'java.lang.OutOfMemoryError' },
    });
    const overflow = computeFingerprint({
      source: 'docker',
      nodeId: 'node-1',
      service: 'app',
      type: 'jvm.stack_overflow',
      attributes: { exceptionClass: 'java.lang.StackOverflowError' },
    });
    const business = computeFingerprint({
      source: 'docker',
      nodeId: 'node-1',
      service: 'app',
      type: 'business.error',
      attributes: { errorCode: 'UNHANDLED_EXCEPTION', module: 'com.example.Service' },
    });
    assert.equal(new Set([oom, overflow, business]).size, 3);
  });
});
