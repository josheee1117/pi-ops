import { randomUUID } from 'node:crypto';
import { buildDelegationTask } from './delegation-task.js';
import { buildInvestigationContext, type InvestigationContext } from './investigation-context.js';
import type { InvestigationReport, InvestigationReportInput } from './investigation-report.js';
import {
  hashInvestigationContext,
  type InvestigationSession,
} from './investigation-session.js';
import type { PiRuntimeClient } from './pi-runtime-client.js';
import { createNoopPiRuntimeClient } from './pi-runtime-client.js';
import type { ReasoningResult } from './reasoner.js';
import {
  buildInvestigationPlan,
  REASONING_STRATEGY_VERSION,
} from './reasoning-strategy.js';
import { hashEvidenceSnapshot } from './reasoning-worker.js';
import type { EventStore } from './store.js';

const MAX_TEXT_CHARS = 2000;

export interface InvestigationLoopStart {
  session: InvestigationSession;
  context: InvestigationContext;
}

export function createInvestigationLoopService(
  store: EventStore,
  options: {
    now?: () => string;
    runtime?: PiRuntimeClient;
  } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const runtime = options.runtime ?? createNoopPiRuntimeClient();

  return {
    start(incidentId: string): InvestigationLoopStart {
      const incident = store.getIncident(incidentId);
      if (!incident) throw new Error(`Incident ${incidentId} does not exist`);
      const evidence = store.listEvidence(incident.id);
      const context = buildInvestigationContext(incident, evidence, store);
      const contextSnapshotHash = hashInvestigationContext(context);
      store.insertInvestigationContextSnapshot(contextSnapshotHash, context, now());
      const taskId = ensureDelegationTask(store, incident.id, now());
      const session: InvestigationSession = {
        id: `isess-${randomUUID()}`,
        incidentId: incident.id,
        contextSnapshotHash,
        delegationTaskId: taskId,
        status: 'CREATED',
        createdAt: now(),
      };
      store.insertInvestigationSession(session);
      return { session, context };
    },

    async submit(sessionId: string): Promise<InvestigationSession> {
      const session = requireSession(store, sessionId);
      if (session.status !== 'CREATED') {
        throw new Error(`InvestigationSession ${sessionId} cannot be submitted`);
      }
      const context = requireSnapshot(store, session.contextSnapshotHash);
      const task = store.getDelegationTask(session.delegationTaskId);
      if (!task) throw new Error(`DelegationTask ${session.delegationTaskId} does not exist`);
      const plan = store.getInvestigationPlan(task.investigationPlanId);
      if (!plan) throw new Error(`InvestigationPlan ${task.investigationPlanId} does not exist`);
      const ack = await runtime.submitInvestigation(session, context);
      if (task.status === 'PENDING') {
        store.markDelegationTaskSubmitted(
          task.id,
          now(),
          ack && 'runtimeTaskId' in ack ? ack.runtimeTaskId : undefined,
        );
      }
      store.updateInvestigationSessionStatus(session.id, 'SUBMITTED');
      return store.getInvestigationSession(session.id)!;
    },

    markRunning(sessionId: string): InvestigationSession {
      const session = requireSession(store, sessionId);
      if (session.status !== 'SUBMITTED') {
        throw new Error(`InvestigationSession ${sessionId} cannot enter RUNNING`);
      }
      store.updateInvestigationSessionStatus(session.id, 'RUNNING');
      return store.getInvestigationSession(session.id)!;
    },

    complete(sessionId: string, input: InvestigationReportInput): InvestigationReport {
      const session = requireSession(store, sessionId);
      const existing = store.getInvestigationReportBySessionId(session.id);
      if (existing && session.status === 'COMPLETED') return existing;
      if (session.status !== 'SUBMITTED' && session.status !== 'RUNNING') {
        throw new Error(`InvestigationSession ${sessionId} cannot accept a report`);
      }
      const report = buildReport(session, input, now());
      validateReport(store, session, report);
      const task = store.getDelegationTask(session.delegationTaskId);
      if (!task) throw new Error(`DelegationTask ${session.delegationTaskId} does not exist`);
      const plan = store.getInvestigationPlan(task.investigationPlanId);
      if (!plan) throw new Error(`InvestigationPlan ${task.investigationPlanId} does not exist`);
      const job = store.getReasoningJob(plan.reasoningJobId);
      if (!job) throw new Error(`ReasoningJob ${plan.reasoningJobId} does not exist`);
      const incident = store.getIncident(session.incidentId)!;
      const evidence = store.listEvidence(incident.id);
      const evidenceIds = uniqueIds([
        ...report.supportingEvidenceIds,
        ...report.contradictingEvidenceIds,
      ]);
      const result: ReasoningResult = {
        id: `reason-${job.id}`,
        incidentId: incident.id,
        createdAt: report.createdAt,
        hypotheses: [report.hypothesis],
        missingEvidence: [],
        confidence: report.confidence,
        status: 'complete',
        reasoningJobId: job.id,
        reasonerType: job.reasonerType,
        reasonerVersion: job.reasonerVersion,
        evidenceIds,
        evidenceSnapshotHash: hashEvidenceSnapshot(evidence),
        reasoningSummary: report.hypothesis,
        recommendedActions: [report.recommendation],
        strategy: plan.strategy,
        strategyVersion: REASONING_STRATEGY_VERSION,
        investigationPlanId: plan.id,
        delegationTaskId: task.id,
        investigationSessionId: session.id,
        investigationReportId: report.id,
      };
      store.insertInvestigationReport(report);
      store.insertReasoningResult(result);
      store.markDelegationTaskCompleted(task.id, report.createdAt);
      if (job.status !== 'COMPLETED') store.markReasoningJobCompleted(job.id);
      store.updateInvestigationSessionStatus(session.id, 'COMPLETED', report.createdAt);
      return report;
    },

    fail(sessionId: string, error: string): InvestigationSession {
      const session = requireSession(store, sessionId);
      if (session.status === 'COMPLETED') {
        throw new Error(`InvestigationSession ${sessionId} is already completed`);
      }
      const task = store.getDelegationTask(session.delegationTaskId);
      if (task && task.status !== 'COMPLETED') {
        store.markDelegationTaskFailed(task.id, error);
      }
      store.updateInvestigationSessionStatus(session.id, 'FAILED', now());
      return store.getInvestigationSession(session.id)!;
    },
  };
}

function ensureDelegationTask(store: EventStore, incidentId: string, createdAt: string): string {
  const jobId = `rj-inv-${incidentId}`;
  if (!store.getReasoningJob(jobId)) {
    store.createReasoningJob({
      id: jobId,
      incidentId,
      reasonerType: 'delegated_analysis',
      reasonerVersion: '1',
      createdAt,
    });
  }
  const incident = store.getIncident(incidentId)!;
  const existingPlans = store.listInvestigationPlansByJob(jobId);
  const plan = existingPlans[0] ?? buildInvestigationPlan(jobId, incident, 'delegated_analysis', createdAt);
  if (!existingPlans[0]) store.insertInvestigationPlan(plan);
  const existingTask = store.getDelegationTaskByPlanId(plan.id);
  if (existingTask) return existingTask.id;
  const task = buildDelegationTask(plan);
  store.insertDelegationTask(task);
  store.markReasoningJobWaitingDelegation(jobId);
  return task.id;
}

function requireSession(store: EventStore, sessionId: string): InvestigationSession {
  const session = store.getInvestigationSession(sessionId);
  if (!session) throw new Error(`InvestigationSession ${sessionId} does not exist`);
  return session;
}

function requireSnapshot(store: EventStore, hash: string): InvestigationContext {
  const snapshot = store.getInvestigationContextSnapshot(hash);
  if (!snapshot) throw new Error(`InvestigationContext snapshot ${hash} does not exist`);
  return snapshot;
}

function buildReport(
  session: InvestigationSession,
  input: InvestigationReportInput,
  createdAt: string,
): InvestigationReport {
  return {
    id: `irpt-${session.id}`,
    sessionId: session.id,
    hypothesis: input.hypothesis,
    supportingEvidenceIds: [...input.supportingEvidenceIds],
    contradictingEvidenceIds: [...input.contradictingEvidenceIds],
    confidence: input.confidence,
    recommendation: input.recommendation,
    createdAt,
  };
}

function validateReport(
  store: EventStore,
  session: InvestigationSession,
  report: InvestigationReport,
): void {
  if (typeof report.hypothesis !== 'string' || report.hypothesis.trim().length === 0) {
    throw new Error('hypothesis must be a non-empty string');
  }
  if (report.hypothesis.length > MAX_TEXT_CHARS) {
    throw new Error(`hypothesis exceeds ${MAX_TEXT_CHARS} characters`);
  }
  if (typeof report.recommendation !== 'string' || report.recommendation.trim().length === 0) {
    throw new Error('recommendation must be a non-empty string');
  }
  if (report.recommendation.length > MAX_TEXT_CHARS) {
    throw new Error(`recommendation exceeds ${MAX_TEXT_CHARS} characters`);
  }
  if (
    typeof report.confidence !== 'number'
    || !Number.isFinite(report.confidence)
    || report.confidence < 0
    || report.confidence > 1
  ) {
    throw new Error('confidence must be a number in [0, 1]');
  }
  if (!Array.isArray(report.supportingEvidenceIds) || !Array.isArray(report.contradictingEvidenceIds)) {
    throw new Error('evidence id lists must be arrays');
  }
  const known = new Set(store.listEvidence(session.incidentId).map((item) => item.id));
  for (const evidenceId of uniqueIds([
    ...report.supportingEvidenceIds,
    ...report.contradictingEvidenceIds,
  ])) {
    if (!known.has(evidenceId)) {
      throw new Error(`evidence id ${evidenceId} does not belong to the Incident`);
    }
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
