import type { InvestigationRuntimeMetadata, InvestigationRuntimeResult } from '@pi-ops/protocol';

export interface RuntimeTask {
  runtimeRequestId: string;
  runtimeTaskId: string;
  sessionId: string;
  incidentId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  metadata?: InvestigationRuntimeMetadata;
  result?: InvestigationRuntimeResult;
}

export function createRuntimeTaskStore() {
  const byRequest = new Map<string, RuntimeTask>();

  return {
    getByRequestId(runtimeRequestId: string): RuntimeTask | undefined {
      return byRequest.get(runtimeRequestId);
    },
    create(input: {
      runtimeRequestId: string;
      sessionId: string;
      incidentId: string;
      now: string;
    }): { task: RuntimeTask; duplicate: boolean } {
      const existing = byRequest.get(input.runtimeRequestId);
      if (existing) return { task: existing, duplicate: true };
      const task: RuntimeTask = {
        runtimeRequestId: input.runtimeRequestId,
        runtimeTaskId: `rtask-${input.runtimeRequestId}`,
        sessionId: input.sessionId,
        incidentId: input.incidentId,
        status: 'queued',
        createdAt: input.now,
      };
      byRequest.set(input.runtimeRequestId, task);
      return { task, duplicate: false };
    },
    update(runtimeRequestId: string, patch: Partial<RuntimeTask>): RuntimeTask {
      const current = byRequest.get(runtimeRequestId);
      if (!current) throw new Error(`unknown runtimeRequestId ${runtimeRequestId}`);
      const next = { ...current, ...patch };
      byRequest.set(runtimeRequestId, next);
      return next;
    },
  };
}

export type RuntimeTaskStore = ReturnType<typeof createRuntimeTaskStore>;
