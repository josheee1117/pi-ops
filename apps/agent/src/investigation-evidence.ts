import {
  planEvidenceQueries,
  type EvidenceOrchestrator,
} from './evidence-orchestrator.js';
import type { AgentConfig } from './config.js';
import type { EventStore } from './store.js';
import type {
  RuntimeEvidenceRequestBatch,
  RuntimeEvidenceResponse,
  RuntimeEvidenceResult,
} from '@pi-ops/protocol';
import {
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
  type EvidenceQueryRequest,
  type OpsEvent,
} from '@pi-ops/protocol';

export function createInvestigationEvidenceService(
  store: EventStore,
  config: AgentConfig,
  orchestrator: EvidenceOrchestrator,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async handle(batch: RuntimeEvidenceRequestBatch): Promise<RuntimeEvidenceResponse> {
      const session = store.getInvestigationSession(batch.sessionId);
      if (!session) throw new Error(`InvestigationSession ${batch.sessionId} does not exist`);
      if (session.runtimeRequestId !== batch.runtimeRequestId) {
        throw new Error('runtimeRequestId does not belong to InvestigationSession');
      }
      const task = store.getDelegationTask(session.delegationTaskId);
      if (!task || task.runtimeTaskId !== batch.runtimeTaskId) {
        throw new Error('runtimeTaskId does not belong to InvestigationSession');
      }
      if (session.status === 'COMPLETED' || session.status === 'FAILED') {
        throw new Error('InvestigationSession is no longer active');
      }
      const incident = store.getIncident(session.incidentId);
      if (!incident) throw new Error('Incident does not exist');
      const results: RuntimeEvidenceResult[] = [];
      for (const item of batch.requests) {
        const createdAt = now();
        const roles = item.requestingRoles ?? [];
        const persist = (status: RuntimeEvidenceResult['status'], evidenceIds: string[], error?: string) => {
          store.insertInvestigationEvidenceAudit({
            requestId: item.requestId,
            investigationSessionId: session.id,
            runtimeRequestId: batch.runtimeRequestId,
            runtimeTaskId: batch.runtimeTaskId,
            specialistRoles: roles,
            evidenceType: item.type,
            status,
            evidenceIds,
            createdAt,
            completedAt: now(),
            error,
          });
        };
        if ((RUNTIME_FORBIDDEN_CAPABILITIES as readonly string[]).includes(item.type)) {
          persist('rejected', [], 'forbidden capability');
          results.push({ requestId: item.requestId, type: item.type, status: 'rejected', error: 'forbidden capability' });
          continue;
        }
        if (!(RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(item.type)) {
          persist('rejected', [], 'evidence type is not allowlisted');
          results.push({ requestId: item.requestId, type: item.type, status: 'rejected', error: 'evidence type is not allowlisted' });
          continue;
        }
        const evidenceId = `inv-${session.id}-evidence-${item.type}`;
        const existing = store.getEvidence(evidenceId)
          ?? store.listEvidence(incident.id).find((row) => row.kind === item.type && row.status === 'succeeded');
        if (existing?.status === 'succeeded') {
          persist('collected', [existing.id]);
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'collected',
            evidenceId: existing.id,
            evidence: existing,
          });
          continue;
        }
        const triggering = triggeringEventFor(store, incident);
        const planned = planEvidenceQueries(incident, triggering, config.evidenceLogsMaxLines);
        const query = planned.find((entry) => entry.type === item.type)
          ?? hostQuery(incident.id, item.type);
        if (!query) {
          persist('rejected', [], 'Pi-Ops could not resolve a permitted target');
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'rejected',
            error: 'Pi-Ops could not resolve a permitted target',
          });
          continue;
        }
        try {
          await orchestrator.collectQueriesForIncident(incident, [query], `inv-${session.id}`);
        } catch {
          persist('unavailable', [], 'evidence collection failed');
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'unavailable',
            error: 'evidence collection failed',
          });
          continue;
        }
        const collected = store.getEvidence(evidenceId);
        if (!collected || collected.status !== 'succeeded') {
          persist('unavailable', [], 'evidence unavailable');
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'unavailable',
            error: 'evidence unavailable',
          });
          continue;
        }
        persist('collected', [collected.id]);
        results.push({
          requestId: item.requestId,
          type: item.type,
          status: 'collected',
          evidenceId: collected.id,
          evidence: collected,
        });
      }
      return {
        schemaVersion: 1,
        runtimeRequestId: batch.runtimeRequestId,
        results,
      };
    },
  };
}

function hostQuery(incidentId: string, type: string): EvidenceQueryRequest | undefined {
  if (type === 'host.memory' || type === 'host.load') {
    return { type, incidentId };
  }
  return undefined;
}

function triggeringEventFor(store: EventStore, incident: { id: string; node_id: string; service: string; type: string; last_seen: string }): OpsEvent {
  const job = store.getEvidenceJob(`job-${incident.id}`);
  if (job) return job.triggeringEvent;
  return {
    schemaVersion: 1,
    id: `evt-synth-${incident.id}`,
    time: incident.last_seen,
    source: 'application',
    nodeId: incident.node_id,
    service: incident.service,
    type: incident.type,
    severity: 'warning',
    message: incident.type,
    attributes: {},
  };
}
