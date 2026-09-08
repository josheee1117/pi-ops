import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSpecialistRoles,
  validateRuntimeEvidenceRequestBatch,
} from '../index.js';

describe('typed evidence request contract', () => {
  it('requires requestingRoles and normalizes them stably', () => {
    const missing = validateRuntimeEvidenceRequestBatch({
      schemaVersion: 1,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      requests: [{ requestId: 'r1', type: 'host.memory' }],
    });
    assert.equal(missing.success, false);

    const empty = validateRuntimeEvidenceRequestBatch({
      schemaVersion: 1,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      requests: [{ requestId: 'r1', type: 'host.memory', requestingRoles: [] }],
    });
    assert.equal(empty.success, false);

    const ok = validateRuntimeEvidenceRequestBatch({
      schemaVersion: 1,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      requests: [{
        requestId: 'r1',
        type: 'host.memory',
        requestingRoles: ['database', 'jvm'],
      }],
    });
    assert.equal(ok.success, true);
    assert.deepEqual(normalizeSpecialistRoles(['container_host', 'jvm', 'jvm', 'database']), [
      'jvm',
      'database',
      'container_host',
    ]);
  });
});
