import type { EvidenceOrchestrator } from './evidence-orchestrator.js';
import type { AgentConfig } from './config.js';
import type { EventStore } from './store.js';
import {
  resolveRuntimeEvidenceQuery,
  trustedTriggeringEventFor,
} from './runtime-evidence-resolver.js';
import type {
  RuntimeEvidenceRequestBatch,
  RuntimeEvidenceResponse,
  RuntimeEvidenceResult,
  RuntimeEvidenceType,
} from '@pi-ops/protocol';
import {
  normalizeSpecialistRoles,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
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
      const seen = new Set<string>();
      for (const item of batch.requests) {
        if (seen.has(item.requestId)) {
          throw new Error(`duplicate requestId ${item.requestId} in one evidence batch`);
        }
        seen.add(item.requestId);
        const createdAt = now();
        const roles = normalizeSpecialistRoles(item.requestingRoles);
        const persist = (
          status: RuntimeEvidenceResult['status'],
          evidenceIds: string[],
          error?: string,
        ) => {
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
        // Enrichment reuse is scoped to this attempt. Older Evidence from a
        // previous attempt stays visible through history, never as a fresh
        // answer to this request.
        const evidenceId = `inv-${session.id}-evidence-${item.type}`;
        const existing = store.getEvidence(evidenceId);
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
        const triggering = trustedTriggeringEventFor(
          incident,
          store.getEvidenceJob(`job-${incident.id}`)?.triggeringEvent,
        );
        const query = resolveRuntimeEvidenceQuery(
          incident,
          triggering,
          item.type as RuntimeEvidenceType,
          config.evidenceLogsMaxLines,
        );
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
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          persist('unavailable', [], `evidence collection failed: ${message}`);
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
          persist('unavailable', [], collected?.error ?? 'evidence unavailable');
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
