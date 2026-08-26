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
} from '@pi-ops/protocol';
import type { OpsEvent } from '@pi-ops/protocol';

export interface InvestigationEvidenceAudit {
  requestId: string;
  investigationSessionId: string;
  runtimeRequestId: string;
  evidenceType: string;
  status: RuntimeEvidenceResult['status'];
  evidenceIds: string[];
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export function createInvestigationEvidenceService(
  store: EventStore,
  config: AgentConfig,
  orchestrator: EvidenceOrchestrator,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const audits = new Map<string, InvestigationEvidenceAudit>();

  return {
    audits,
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
        if ((RUNTIME_FORBIDDEN_CAPABILITIES as readonly string[]).includes(item.type)) {
          results.push({ requestId: item.requestId, type: item.type, status: 'rejected', error: 'forbidden capability' });
          continue;
        }
        if (!(RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(item.type)) {
          results.push({ requestId: item.requestId, type: item.type, status: 'rejected', error: 'evidence type is not allowlisted' });
          continue;
        }
        const existing = store.listEvidence(incident.id).find((row) => row.kind === item.type && row.status === 'succeeded');
        if (existing) {
          const audit: InvestigationEvidenceAudit = {
            requestId: item.requestId,
            investigationSessionId: session.id,
            runtimeRequestId: batch.runtimeRequestId,
            evidenceType: item.type,
            status: 'collected',
            evidenceIds: [existing.id],
            createdAt,
            completedAt: now(),
          };
          audits.set(item.requestId, audit);
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
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'rejected',
            error: 'Pi-Ops could not resolve a permitted target',
          });
          continue;
        }
        const evidenceId = `inv-${session.id}-evidence-${item.type}`;
        try {
          await orchestrator.collectForIncident(incident, triggering, `inv-${session.id}`);
        } catch {
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'unavailable',
            error: 'evidence collection failed',
          });
          continue;
        }
        const collected = store.listEvidence(incident.id).find((row) => (
          (row.id === evidenceId || row.kind === item.type) && row.status === 'succeeded'
        ));
        if (!collected) {
          results.push({
            requestId: item.requestId,
            type: item.type,
            status: 'unavailable',
            error: 'evidence unavailable',
          });
          continue;
        }
        audits.set(item.requestId, {
          requestId: item.requestId,
          investigationSessionId: session.id,
          runtimeRequestId: batch.runtimeRequestId,
          evidenceType: item.type,
          status: 'collected',
          evidenceIds: [collected.id],
          createdAt,
          completedAt: now(),
        });
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

function hostQuery(incidentId: string, type: string) {
  if (type === 'host.memory' || type === 'host.load') {
    return { type, incidentId } as const;
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
