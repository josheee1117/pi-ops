import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpecialists } from '../specialists.js';
import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

function context(type: string): RuntimeInvestigationContext {
  return {
    schemaVersion: 1,
    incident: { id: 'inc-runtime', type, service: 'ragflow' },
    evidence: [{ id: 'evd-logs', kind: 'docker.logs' }],
    historicalKnowledgeStatus: 'unavailable',
  };
}

describe('runtime log faults select application and host specialists', () => {
  for (const type of ['runtime.oom', 'runtime.stack_overflow']) {
    it(`selects application_business and container_host for ${type}`, () => {
      const selected = selectSpecialists(context(type));
      assert.deepEqual(selected, ['application_business', 'container_host']);
    });
  }
});
