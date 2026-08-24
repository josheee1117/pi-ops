import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { OpsEvent, EventBatch, Evidence } from '@pi-ops/protocol';
import { computeFingerprint } from './fingerprint.js';
import type { ReasoningResult } from './reasoner.js';
import type { MemoryCandidate, ReasoningEvaluation } from './reasoning-evaluation.js';
import type { MemoryFeedback } from './memory-feedback.js';
import type { MemoryEntry } from './memory-governance.js';
import type { InvestigationPlan } from './reasoning-strategy.js';
import type { InvestigationReport } from './investigation-report.js';
import type { InvestigationContext } from './investigation-context.js';
import type { InvestigationSession } from './investigation-session.js';
import type { DelegationTask } from './delegation-task.js';

// ── Event types ──────────────────────────────────────────────────────────────

export class DuplicateEventConflictError extends Error {
  constructor(readonly eventId: string) {
    super(`Event ${eventId} conflicts with the persisted immutable payload`);
    this.name = 'DuplicateEventConflictError';
  }
}

export interface ProcessBatchResult {
  inserted: number;
  processed: number;
  createdIncidents: number;
}

export interface StoredEvent {
  id: string;
  schema_version: number;
  event_time: string;
  receive_time: string;
  producer_id: string;
  producer_type: string;
  producer_version: string;
  source: string;
  node_id: string;
  service: string;
  type: string;
  severity: string;
  fingerprint: string | null;
  trace_id: string | null;
  message: string;
  attributes: string;
}

// ── Incident types ───────────────────────────────────────────────────────────

export type IncidentState = 'OPEN' | 'INVESTIGATING' | 'NOTIFIED' | 'RECOVERED' | 'CLOSED';

export interface IncidentRow {
  id: string;
  service: string;
  node_id: string;
  type: string;
  state: IncidentState;
  fingerprint: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
  severity: string;
}

// ── Evidence types ───────────────────────────────────────────────────────────

export type EvidenceStatus = 'succeeded' | 'failed';
export type EvidenceFailureClass = 'retryable' | 'terminal';

export interface EvidenceRecord extends Evidence {
  status: EvidenceStatus;
  error?: string;
  failureClass?: EvidenceFailureClass;
}

export interface EvidenceRow {
  id: string;
  incident_id: string;
  node_id: string;
  source: string;
  kind: string;
  collected_at: string;
  status: EvidenceStatus;
  data_json: string;
  error: string | null;
  failure_class: EvidenceFailureClass | null;
}

// ── Evidence job types ───────────────────────────────────────────────────────

export type EvidenceJobState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface EvidenceJob {
  id: string;
  incidentId: string;
  triggeringEvent: OpsEvent;
  state: EvidenceJobState;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface EvidenceJobRow {
  id: string;
  incident_id: string;
  event_json: string;
  state: EvidenceJobState;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type ReasoningJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_DELEGATION';

export interface ReasoningJob {
  id: string;
  incidentId: string;
  reasonerType: string;
  reasonerVersion: string;
  status: ReasoningJobStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface ReasoningJobRow {
  id: string;
  incident_id: string;
  reasoner_type: string;
  reasoner_version: string;
  status: ReasoningJobStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const CREATE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  event_time TEXT NOT NULL,
  receive_time TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_type TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source TEXT NOT NULL,
  node_id TEXT NOT NULL,
  service TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  fingerprint TEXT,
  trace_id TEXT,
  message TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}'
);
`;

const CREATE_INCIDENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  fingerprint TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  severity TEXT NOT NULL
);
`;

const CREATE_INCIDENT_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS incident_events (
  incident_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (incident_id, event_id),
  UNIQUE (event_id)
);
`;

const CREATE_EVIDENCE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  error TEXT,
  failure_class TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_incident_id ON evidence (incident_id);
`;

const CREATE_EVIDENCE_JOBS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS evidence_jobs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_jobs_state ON evidence_jobs (state, created_at);
`;

const CREATE_REASONING_RESULTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reasoning_results (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hypotheses_json TEXT NOT NULL,
  missing_evidence_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  reasoning_job_id TEXT,
  reasoner_type TEXT,
  reasoner_version TEXT,
  evidence_ids TEXT,
  evidence_snapshot_hash TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_reasoning_results_incident
  ON reasoning_results (incident_id, created_at, id);
`;

const CREATE_REASONING_JOBS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reasoning_jobs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL UNIQUE,
  reasoner_type TEXT NOT NULL,
  reasoner_version TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasoning_jobs_status ON reasoning_jobs (status, created_at);
`;

const CREATE_REASONING_EVALUATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reasoning_evaluations (
  id TEXT PRIMARY KEY,
  reasoning_result_id TEXT NOT NULL,
  evaluator_type TEXT NOT NULL,
  score REAL NOT NULL,
  confidence_score REAL,
  evidence_coverage_score REAL,
  feedback TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasoning_evaluations_result
  ON reasoning_evaluations (reasoning_result_id, created_at, id);
`;

const CREATE_MEMORY_CANDIDATES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  source_reasoning_result_id TEXT NOT NULL,
  source_evaluation_id TEXT,
  incident_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  resolution TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_source
  ON memory_candidates (source_reasoning_result_id, created_at, id);
`;

const CREATE_MEMORY_ENTRIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  source_memory_candidate_id TEXT NOT NULL UNIQUE,
  source_evaluation_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  resolution TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_entries_status ON memory_entries (status, created_at, id);
`;

const CREATE_MEMORY_FEEDBACKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memory_feedbacks (
  id TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  reasoning_result_id TEXT,
  outcome TEXT NOT NULL,
  effectiveness_score REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_feedbacks_entry
  ON memory_feedbacks (memory_entry_id, created_at, id);
`;

const CREATE_INVESTIGATION_PLANS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS investigation_plans (
  id TEXT PRIMARY KEY,
  reasoning_job_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  objectives_json TEXT NOT NULL,
  requested_capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investigation_plans_job ON investigation_plans (reasoning_job_id, created_at, id);
`;

const CREATE_DELEGATION_TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS delegation_tasks (
  id TEXT PRIMARY KEY,
  investigation_plan_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT,
  runtime_task_id TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegation_tasks_status ON delegation_tasks (status, id);
`;

const CREATE_INVESTIGATION_CONTEXT_SNAPSHOTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS investigation_context_snapshots (
  hash TEXT PRIMARY KEY,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const CREATE_INVESTIGATION_SESSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS investigation_sessions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  context_snapshot_hash TEXT NOT NULL,
  delegation_task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_investigation_sessions_incident
  ON investigation_sessions (incident_id, created_at, id);
`;

const CREATE_INVESTIGATION_REPORTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS investigation_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  hypothesis TEXT NOT NULL,
  supporting_evidence_ids_json TEXT NOT NULL,
  contradicting_evidence_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  recommendation TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const INSERT_EVENT_SQL = `
INSERT OR IGNORE INTO events (
  id, schema_version, event_time, receive_time,
  producer_id, producer_type, producer_version,
  source, node_id, service, type, severity,
  fingerprint, trace_id, message, attributes
) VALUES (
  @id, @schema_version, @event_time, @receive_time,
  @producer_id, @producer_type, @producer_version,
  @source, @node_id, @service, @type, @severity,
  @fingerprint, @trace_id, @message, @attributes
);
`;

const COUNT_EVENTS_SQL = `SELECT COUNT(*) as count FROM events`;
const GET_EVENT_SQL = `
SELECT id, schema_version, event_time, receive_time,
       producer_id, producer_type, producer_version,
       source, node_id, service, type, severity,
       fingerprint, trace_id, message, attributes
FROM events WHERE id = ?;
`;

const CREATE_EVENT_PROCESSING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS event_processing (
  event_id TEXT PRIMARY KEY,
  incident_processed_at TEXT NOT NULL
);
`;

const GET_EVENT_PROCESSED_AT_SQL = `
SELECT incident_processed_at FROM event_processing WHERE event_id = ?;
`;

const LIST_UNPROCESSED_EVENTS_SQL = `
SELECT events.id, events.schema_version, events.event_time, events.receive_time,
       events.producer_id, events.producer_type, events.producer_version,
       events.source, events.node_id, events.service, events.type, events.severity,
       events.fingerprint, events.trace_id, events.message, events.attributes
FROM events
LEFT JOIN event_processing ON event_processing.event_id = events.id
WHERE event_processing.event_id IS NULL
ORDER BY julianday(events.event_time), events.id
LIMIT @limit;
`;

const MARK_EVENT_PROCESSED_SQL = `
INSERT OR IGNORE INTO event_processing (event_id, incident_processed_at)
VALUES (@id, @processed_at);
`;

const CREATE_PENDING_RECOVERIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pending_recoveries (
  event_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  event_time TEXT NOT NULL,
  event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_recoveries_fingerprint_time
  ON pending_recoveries (fingerprint, event_time, event_id);
`;

const INSERT_PENDING_RECOVERY_SQL = `
INSERT OR IGNORE INTO pending_recoveries (
  event_id, fingerprint, event_time, event_json
) VALUES (
  @event_id, @fingerprint, @event_time, @event_json
);
`;

const LIST_PENDING_RECOVERIES_SQL = `
SELECT event_json FROM pending_recoveries
WHERE fingerprint = @fingerprint
ORDER BY julianday(event_time), event_id;
`;

const LIST_PENDING_RECOVERY_FINGERPRINTS_SQL = `
SELECT DISTINCT fingerprint FROM pending_recoveries ORDER BY fingerprint;
`;

const DELETE_PENDING_RECOVERY_SQL = `
DELETE FROM pending_recoveries WHERE event_id = ?;
`;

const LIST_INCIDENTS_BY_FINGERPRINT_SQL = `
SELECT * FROM incidents WHERE fingerprint = @fingerprint;
`;

const LIST_ACTIVE_INCIDENTS_SQL = `
SELECT * FROM incidents
WHERE fingerprint = @fingerprint
  AND state IN ('OPEN', 'INVESTIGATING', 'NOTIFIED');
`;

const FIND_INCIDENT_BY_EVENT_ID_SQL = `
SELECT incidents.*
FROM incidents
JOIN incident_events ON incident_events.incident_id = incidents.id
WHERE incident_events.event_id = ?
LIMIT 1;
`;

const INSERT_INCIDENT_SQL = `
INSERT INTO incidents (
  id, service, node_id, type, state, fingerprint,
  first_seen, last_seen, event_count, severity
) VALUES (
  @id, @service, @node_id, @type, @state, @fingerprint,
  @first_seen, @last_seen, @event_count, @severity
);
`;

const UPDATE_INCIDENT_SQL = `
UPDATE incidents
SET first_seen = @first_seen,
    last_seen = @last_seen,
    event_count = @event_count,
    severity = @severity,
    state = @state
WHERE id = @id;
`;

const LINK_EVENT_SQL = `
INSERT OR IGNORE INTO incident_events (incident_id, event_id)
VALUES (@incident_id, @event_id);
`;

const COUNT_INCIDENTS_SQL = `SELECT COUNT(*) as count FROM incidents`;

const INSERT_EVIDENCE_SQL = `
INSERT INTO evidence (
  id, incident_id, node_id, source, kind, collected_at,
  status, data_json, error, failure_class
) VALUES (
  @id, @incident_id, @node_id, @source, @kind, @collected_at,
  @status, @data_json, @error, @failure_class
)
ON CONFLICT(id) DO UPDATE SET
  incident_id = excluded.incident_id,
  node_id = excluded.node_id,
  source = excluded.source,
  kind = excluded.kind,
  collected_at = excluded.collected_at,
  status = excluded.status,
  data_json = excluded.data_json,
  error = excluded.error,
  failure_class = excluded.failure_class;
`;

const LIST_EVIDENCE_SQL = `
SELECT * FROM evidence WHERE incident_id = ? ORDER BY collected_at, id;
`;

const COUNT_EVIDENCE_SQL = `SELECT COUNT(*) as count FROM evidence`;

const INSERT_EVIDENCE_JOB_SQL = `
INSERT INTO evidence_jobs (
  id, incident_id, event_json, state, attempts, last_error, created_at, updated_at
) VALUES (
  @id, @incident_id, @event_json, 'PENDING', 0, NULL, @created_at, @updated_at
);
`;

const REQUEUE_EVIDENCE_JOB_SQL = `
UPDATE evidence_jobs
SET state = 'PENDING',
    event_json = @event_json,
    attempts = 0,
    last_error = NULL,
    updated_at = @updated_at
WHERE incident_id = @incident_id
  AND state IN ('COMPLETED', 'FAILED');
`;

const LIST_PENDING_EVIDENCE_JOBS_SQL = `
SELECT * FROM evidence_jobs
WHERE state = 'PENDING'
ORDER BY created_at, id
LIMIT ?;
`;

const MARK_EVIDENCE_JOB_RUNNING_SQL = `
UPDATE evidence_jobs
SET state = 'RUNNING', attempts = attempts + 1, updated_at = @updated_at
WHERE id = @id AND state = 'PENDING';
`;

const MARK_EVIDENCE_JOB_COMPLETED_SQL = `
UPDATE evidence_jobs
SET state = 'COMPLETED', last_error = NULL, updated_at = @updated_at
WHERE id = @id;
`;

const MARK_EVIDENCE_JOB_RETRY_SQL = `
UPDATE evidence_jobs
SET state = @state, last_error = @last_error, updated_at = @updated_at
WHERE id = @id;
`;

const RESET_RUNNING_EVIDENCE_JOBS_SQL = `
UPDATE evidence_jobs SET state = 'PENDING', updated_at = ? WHERE state = 'RUNNING';
`;

const INSERT_REASONING_JOB_SQL = `
INSERT OR IGNORE INTO reasoning_jobs (
  id, incident_id, reasoner_type, reasoner_version, status, attempts, last_error, created_at, updated_at
) VALUES (
  @id, @incident_id, @reasoner_type, @reasoner_version, 'PENDING', 0, NULL, @created_at, @updated_at
);
`;

const LIST_PENDING_REASONING_JOBS_SQL = `
SELECT * FROM reasoning_jobs
WHERE status = 'PENDING'
ORDER BY created_at, id
LIMIT ?;
`;

const MARK_REASONING_JOB_RUNNING_SQL = `
UPDATE reasoning_jobs
SET status = 'RUNNING', attempts = attempts + 1, updated_at = @updated_at
WHERE id = @id AND status = 'PENDING';
`;

const MARK_REASONING_JOB_COMPLETED_SQL = `
UPDATE reasoning_jobs
SET status = 'COMPLETED', last_error = NULL, updated_at = @updated_at
WHERE id = @id;
`;

const MARK_REASONING_JOB_FAILED_SQL = `
UPDATE reasoning_jobs
SET status = 'FAILED', last_error = @last_error, updated_at = @updated_at
WHERE id = @id;
`;

const MARK_REASONING_JOB_WAITING_DELEGATION_SQL = `
UPDATE reasoning_jobs
SET status = 'WAITING_DELEGATION', last_error = NULL, updated_at = @updated_at
WHERE id = @id;
`;

const RESET_RUNNING_REASONING_JOBS_SQL = `
UPDATE reasoning_jobs SET status = 'PENDING', updated_at = ? WHERE status = 'RUNNING';
`;

// ── Store interface ──────────────────────────────────────────────────────────

export interface EventStore {
  /** Insert a validated batch. Returns the number of newly inserted rows. */
  insertBatch(batch: EventBatch, receiveTime: string): number;

  /** Atomically persist a batch and apply synchronous Incident processing. */
  processBatch(
    batch: EventBatch,
    receiveTime: string,
    processEvent: (event: OpsEvent) => { isNew: boolean },
  ): ProcessBatchResult;

  /** Total event count. */
  count(): number;

  /** Read one immutable Event exactly as persisted. */
  getEvent(id: string): StoredEvent | undefined;

  /** Read the separate Incident-processing completion marker. */
  getEventProcessedAt(id: string): string | undefined;

  /** Mark an Event processed when reconciliation applies it indirectly. */
  markEventProcessed(id: string, processedAt: string): void;

  /** Atomically replay all durable Events still pending Incident processing. */
  replayPendingEvents(
    processEvent: (event: OpsEvent) => void,
    processedAt: string,
    limit: number,
  ): number;

  // ── Incident operations ──────────────────────────────────────────────────

  /** Persist an unmatched recovery for deterministic later reconciliation. */
  addPendingRecovery(event: OpsEvent, fingerprint: string): void;

  /** List pending recoveries for one central fingerprint in event-time order. */
  listPendingRecoveries(fingerprint: string): OpsEvent[];

  /** Distinct fingerprints with unmatched recoveries, ordered deterministically. */
  listPendingRecoveryFingerprints(): string[];

  /** Remove one recovery after it is linked to an Incident. */
  removePendingRecovery(eventId: string): void;

  /** Atomically apply a recovery onto one Incident. */
  applyRecovery(incidentId: string, recovery: OpsEvent): boolean;

  /** Total unmatched recovery count. */
  pendingRecoveryCount(): number;

  /** Find the nearest active Incident inside the event-time aggregation window. */
  findActiveIncident(
    fingerprint: string,
    timestamp: string,
    aggregationWindowMs: number,
  ): IncidentRow | undefined;

  /** Find the latest active Incident whose observed interval precedes recovery. */
  findRecoveryIncident(fingerprint: string, timestamp: string): IncidentRow | undefined;

  /** Find the nearest active or historically terminal Incident for an Event. */
  findIncidentForEvent(
    fingerprint: string,
    timestamp: string,
    aggregationWindowMs: number,
  ): IncidentRow | undefined;

  /** Find the Incident already linked to an immutable Event fact. */
  findIncidentByEventId(eventId: string): IncidentRow | undefined;

  /** Create a new incident without scheduling evidence (tests/manual use). */
  createIncident(incident: Omit<IncidentRow, 'id'>): IncidentRow;

  /** Atomically create Incident + event link + durable evidence and reasoning jobs. */
  createIncidentFromEvent(
    incident: Omit<IncidentRow, 'id'>,
    event: OpsEvent,
    reasoning?: { reasonerType: string; reasonerVersion: string },
  ): IncidentRow;

  /** Update an existing incident's mutable fields. */
  updateIncident(id: string, updates: {
    first_seen: string;
    last_seen: string;
    event_count: number;
    severity: string;
    state: IncidentState;
  }): void;

  /** Link an event to an incident. Returns true if the link was newly created. */
  linkEventToIncident(incidentId: string, eventId: string): boolean;

  /** Total incident count. */
  incidentCount(): number;

  /** Get an incident by id. */
  getIncident(id: string): IncidentRow | undefined;

  // ── Evidence operations ──────────────────────────────────────────────────

  /** Persist one successful or failed evidence item. */
  insertEvidence(evidence: EvidenceRecord): void;

  /** List evidence records for one incident. */
  listEvidence(incidentId: string): EvidenceRecord[];

  /** Total evidence record count. */
  evidenceCount(): number;

  // ── Durable evidence jobs ────────────────────────────────────────────────

  listPendingEvidenceJobs(limit: number): EvidenceJob[];
  markEvidenceJobRunning(id: string): boolean;
  markEvidenceJobCompleted(id: string): void;
  markEvidenceJobRetry(id: string, error: string, failed: boolean): void;
  resetRunningEvidenceJobs(): number;
  getEvidenceJob(id: string): EvidenceJob | undefined;
  /** Requeue a terminal Evidence job for one Incident. No-op if still pending/running. */
  requeueEvidenceJob(incidentId: string, event: OpsEvent): boolean;

  // ── Reasoning ────────────────────────────────────────────────────────────

  createReasoningJob(job: {
    id: string;
    incidentId: string;
    reasonerType: string;
    reasonerVersion: string;
    createdAt: string;
  }): void;
  listPendingReasoningJobs(limit: number): ReasoningJob[];
  markReasoningJobRunning(id: string): boolean;
  markReasoningJobCompleted(id: string): void;
  markReasoningJobFailed(id: string, error: string): void;
  markReasoningJobWaitingDelegation(id: string): void;
  resetRunningReasoningJobs(): number;
  getReasoningJob(id: string): ReasoningJob | undefined;
  insertReasoningResult(result: ReasoningResult): boolean;
  listReasoningResults(incidentId: string): ReasoningResult[];
  getReasoningResult(id: string): ReasoningResult | undefined;
  getReasoningResultByJobId(jobId: string): ReasoningResult | undefined;
  insertReasoningEvaluation(evaluation: ReasoningEvaluation): void;
  listReasoningEvaluations(reasoningResultId: string): ReasoningEvaluation[];
  insertMemoryCandidate(candidate: MemoryCandidate): void;
  listMemoryCandidates(sourceReasoningResultId?: string): MemoryCandidate[];
  getMemoryCandidate(id: string): MemoryCandidate | undefined;
  updateMemoryCandidateStatus(id: string, status: MemoryCandidate['status']): void;
  getReasoningEvaluation(id: string): ReasoningEvaluation | undefined;
  insertMemoryEntry(entry: MemoryEntry): void;
  getMemoryEntry(id: string): MemoryEntry | undefined;
  getMemoryEntryByCandidateId(candidateId: string): MemoryEntry | undefined;
  listActiveMemoryEntries(): MemoryEntry[];
  updateMemoryEntryStatus(id: string, status: MemoryEntry['status']): void;
  insertMemoryFeedback(feedback: MemoryFeedback): void;
  listMemoryFeedbacks(memoryEntryId: string): MemoryFeedback[];
  insertInvestigationPlan(plan: InvestigationPlan): void;
  getInvestigationPlan(id: string): InvestigationPlan | undefined;
  listInvestigationPlansByJob(reasoningJobId: string): InvestigationPlan[];
  insertDelegationTask(task: DelegationTask): void;
  getDelegationTask(id: string): DelegationTask | undefined;
  getDelegationTaskByPlanId(planId: string): DelegationTask | undefined;
  markDelegationTaskSubmitted(id: string, submittedAt: string, runtimeTaskId?: string): void;
  markDelegationTaskCompleted(id: string, completedAt: string): void;
  markDelegationTaskFailed(id: string, error: string): void;
  insertInvestigationContextSnapshot(hash: string, context: InvestigationContext, createdAt: string): void;
  getInvestigationContextSnapshot(hash: string): InvestigationContext | undefined;
  insertInvestigationSession(session: InvestigationSession): void;
  getInvestigationSession(id: string): InvestigationSession | undefined;
  updateInvestigationSessionStatus(
    id: string,
    status: InvestigationSession['status'],
    completedAt?: string,
  ): void;
  insertInvestigationReport(report: InvestigationReport): void;
  getInvestigationReport(id: string): InvestigationReport | undefined;
  getInvestigationReportBySessionId(sessionId: string): InvestigationReport | undefined;

  /** Close the database connection. */
  close(): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

interface EvaluationRow {
  id: string;
  reasoning_result_id: string;
  evaluator_type: string;
  score: number;
  confidence_score: number | null;
  evidence_coverage_score: number | null;
  feedback: string;
  created_at: string;
}

function mapEvaluationRow(row: EvaluationRow): ReasoningEvaluation {
  const confidenceScore = row.confidence_score ?? row.score;
  const evidenceCoverageScore = row.evidence_coverage_score ?? row.score;
  return {
    id: row.id,
    reasoningResultId: row.reasoning_result_id,
    evaluatorType: row.evaluator_type,
    score: row.score,
    confidenceScore,
    evidenceCoverageScore,
    feedback: row.feedback,
    createdAt: row.created_at,
  };
}

interface MemoryCandidateRow {
  id: string;
  source_reasoning_result_id: string;
  source_evaluation_id: string | null;
  incident_type: string;
  pattern: string;
  evidence_summary: string;
  conclusion: string;
  resolution: string;
  confidence: number;
  status: MemoryCandidate['status'];
  created_at: string;
}

interface MemoryEntryRow {
  id: string;
  source_memory_candidate_id: string;
  source_evaluation_id: string;
  pattern: string;
  evidence_summary: string;
  conclusion: string;
  resolution: string;
  confidence: number;
  status: MemoryEntry['status'];
  created_at: string;
  approved_at: string;
}

function mapMemoryCandidateRow(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    sourceReasoningResultId: row.source_reasoning_result_id,
    sourceEvaluationId: row.source_evaluation_id ?? '',
    incidentType: row.incident_type,
    pattern: row.pattern,
    evidenceSummary: row.evidence_summary,
    conclusion: row.conclusion,
    resolution: row.resolution,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
  };
}

interface InvestigationPlanRow {
  id: string;
  reasoning_job_id: string;
  strategy: InvestigationPlan['strategy'];
  objectives_json: string;
  requested_capabilities_json: string;
  created_at: string;
}

interface DelegationTaskRow {
  id: string;
  investigation_plan_id: string;
  status: DelegationTask['status'];
  submitted_at: string | null;
  completed_at: string | null;
  runtime_task_id: string | null;
  last_error: string | null;
}

interface InvestigationSessionRow {
  id: string;
  incident_id: string;
  context_snapshot_hash: string;
  delegation_task_id: string;
  status: InvestigationSession['status'];
  created_at: string;
  completed_at: string | null;
}

interface InvestigationReportRow {
  id: string;
  session_id: string;
  hypothesis: string;
  supporting_evidence_ids_json: string;
  contradicting_evidence_ids_json: string;
  confidence: number;
  recommendation: string;
  created_at: string;
}

function mapInvestigationSessionRow(row: InvestigationSessionRow): InvestigationSession {
  return {
    id: row.id,
    incidentId: row.incident_id,
    contextSnapshotHash: row.context_snapshot_hash,
    delegationTaskId: row.delegation_task_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function mapInvestigationReportRow(row: InvestigationReportRow): InvestigationReport {
  return {
    id: row.id,
    sessionId: row.session_id,
    hypothesis: row.hypothesis,
    supportingEvidenceIds: JSON.parse(row.supporting_evidence_ids_json) as string[],
    contradictingEvidenceIds: JSON.parse(row.contradicting_evidence_ids_json) as string[],
    confidence: row.confidence,
    recommendation: row.recommendation,
    createdAt: row.created_at,
  };
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeSnapshot(nested);
  }
  return value;
}

function mapDelegationTaskRow(row: DelegationTaskRow): DelegationTask {
  return {
    id: row.id,
    investigationPlanId: row.investigation_plan_id,
    status: row.status,
    ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.runtime_task_id ? { runtimeTaskId: row.runtime_task_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function mapInvestigationPlanRow(row: InvestigationPlanRow): InvestigationPlan {
  return {
    id: row.id,
    reasoningJobId: row.reasoning_job_id,
    strategy: row.strategy,
    objectives: JSON.parse(row.objectives_json) as string[],
    requestedCapabilities: JSON.parse(row.requested_capabilities_json) as string[],
    createdAt: row.created_at,
  };
}

interface MemoryFeedbackRow {
  id: string;
  memory_entry_id: string;
  incident_id: string;
  reasoning_result_id: string | null;
  outcome: MemoryFeedback['outcome'];
  effectiveness_score: number;
  created_at: string;
}

function mapMemoryFeedbackRow(row: MemoryFeedbackRow): MemoryFeedback {
  return {
    id: row.id,
    memoryEntryId: row.memory_entry_id,
    incidentId: row.incident_id,
    ...(row.reasoning_result_id ? { reasoningResultId: row.reasoning_result_id } : {}),
    outcome: row.outcome,
    effectivenessScore: row.effectiveness_score,
    createdAt: row.created_at,
  };
}

function mapMemoryEntryRow(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    sourceMemoryCandidateId: row.source_memory_candidate_id,
    sourceEvaluationId: row.source_evaluation_id,
    pattern: row.pattern,
    evidenceSummary: row.evidence_summary,
    conclusion: row.conclusion,
    resolution: row.resolution,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

function serializeReasoningMetadata(result: ReasoningResult): string | null {
  const metadata: Record<string, unknown> = {};
  if (result.provider) metadata['provider'] = result.provider;
  if (result.model) metadata['model'] = result.model;
  if (result.reasoningSummary) metadata['reasoningSummary'] = result.reasoningSummary;
  if (result.recommendedActions) metadata['recommendedActions'] = result.recommendedActions;
  if (result.needHuman !== undefined) metadata['needHuman'] = result.needHuman;
  if (result.usage) metadata['usage'] = result.usage;
  if (result.truncated) metadata['truncated'] = true;
  if (result.missingCapability && result.missingCapability.length > 0) {
    metadata['missingCapability'] = result.missingCapability;
  }
  if (result.usedMemoryEntryIds && result.usedMemoryEntryIds.length > 0) {
    metadata['usedMemoryEntryIds'] = result.usedMemoryEntryIds;
  }
  if (result.strategy) metadata['strategy'] = result.strategy;
  if (result.strategyVersion) metadata['strategyVersion'] = result.strategyVersion;
  if (result.investigationPlanId) metadata['investigationPlanId'] = result.investigationPlanId;
  if (result.delegationTaskId) metadata['delegationTaskId'] = result.delegationTaskId;
  if (result.investigationSessionId) metadata['investigationSessionId'] = result.investigationSessionId;
  if (result.investigationReportId) metadata['investigationReportId'] = result.investigationReportId;
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

function parseReasoningMetadata(raw: string | null): Partial<ReasoningResult> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<ReasoningResult>;
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.reasoningSummary === 'string' ? { reasoningSummary: parsed.reasoningSummary } : {}),
      ...(Array.isArray(parsed.recommendedActions) ? { recommendedActions: parsed.recommendedActions } : {}),
      ...(typeof parsed.needHuman === 'boolean' ? { needHuman: parsed.needHuman } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.truncated ? { truncated: true } : {}),
      ...(Array.isArray(parsed.missingCapability) ? { missingCapability: parsed.missingCapability } : {}),
      ...(Array.isArray(parsed.usedMemoryEntryIds) ? { usedMemoryEntryIds: parsed.usedMemoryEntryIds } : {}),
      ...(typeof parsed.strategy === 'string' ? { strategy: parsed.strategy } : {}),
      ...(typeof parsed.strategyVersion === 'string' ? { strategyVersion: parsed.strategyVersion } : {}),
      ...(typeof parsed.investigationPlanId === 'string' ? { investigationPlanId: parsed.investigationPlanId } : {}),
      ...(typeof parsed.delegationTaskId === 'string' ? { delegationTaskId: parsed.delegationTaskId } : {}),
      ...(typeof parsed.investigationSessionId === 'string' ? { investigationSessionId: parsed.investigationSessionId } : {}),
      ...(typeof parsed.investigationReportId === 'string' ? { investigationReportId: parsed.investigationReportId } : {}),
    };
  } catch {
    return {};
  }
}

export function createEventStore(dbPath: string): EventStore {
  const db = new Database(dbPath);

  // Performance + safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const migrateSchema = db.transaction(() => {
    db.exec(CREATE_EVENTS_TABLE_SQL);

    // Migrate databases created before canonical event timestamps and protocol
    // versions were persisted. receive_time is the only durable timestamp
    // available for legacy rows, so it is the deterministic backfill.
    const eventColumns = new Set(
      (db.pragma('table_info(events)') as Array<{ name: string }>).map(({ name }) => name),
    );
    if (!eventColumns.has('schema_version')) {
      db.exec('ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!eventColumns.has('event_time')) {
      db.exec("ALTER TABLE events ADD COLUMN event_time TEXT NOT NULL DEFAULT ''");
    }
    db.exec(
      "UPDATE events SET event_time = receive_time WHERE event_time IS NULL OR event_time = ''",
    );

    db.exec(CREATE_INCIDENTS_TABLE_SQL);
    db.exec(CREATE_INCIDENT_EVENTS_TABLE_SQL);
    db.exec(CREATE_EVENT_PROCESSING_TABLE_SQL);
    db.exec(CREATE_PENDING_RECOVERIES_TABLE_SQL);

    // Recompute linkable Incident fingerprints using every immutable Event.
    // A legacy producer fingerprint could have merged unrelated identities;
    // fail closed rather than silently cementing that corruption.
    const legacyIncidents = db.prepare(
      'SELECT id, state FROM incidents',
    ).all() as Array<{ id: string; state: IncidentState }>;
    const linkedIdentities = db.prepare(`
      SELECT events.source, events.node_id, events.service, events.type, events.attributes
      FROM incident_events
      JOIN events ON events.id = incident_events.event_id
      WHERE incident_events.incident_id = ?
      ORDER BY julianday(events.event_time), events.id;
    `);
    const updateFingerprint = db.prepare(
      'UPDATE incidents SET fingerprint = ? WHERE id = ?',
    );
    for (const incident of legacyIncidents) {
      const rows = linkedIdentities.all(incident.id) as Array<{
        source: string;
        node_id: string;
        service: string;
        type: string;
        attributes: string;
      }>;
      const identities = new Set(rows.map((event) => computeFingerprint({
        source: event.source as OpsEvent['source'],
        nodeId: event.node_id,
        service: event.service,
        type: event.type,
        attributes: JSON.parse(event.attributes) as Record<string, unknown>,
      })));
      if (identities.size > 1) {
        throw new Error(
          `Incident ${incident.id} links Events with multiple central identities`,
        );
      }
      if (identities.size === 0) {
        if (['OPEN', 'INVESTIGATING', 'NOTIFIED'].includes(incident.state)) {
          throw new Error(`Active Incident ${incident.id} has no linked immutable Event`);
        }
        continue;
      }
      updateFingerprint.run([...identities][0], incident.id);
    }

    // Preserve markers from the short-lived transitional schema if present.
    if (eventColumns.has('incident_processed_at')) {
      db.exec(`
        INSERT OR IGNORE INTO event_processing (event_id, incident_processed_at)
        SELECT id, incident_processed_at FROM events
        WHERE incident_processed_at IS NOT NULL;
      `);
    }

    // Rows already linked to an Incident were processed by older versions.
    // Every other unlinked legacy Event, including recoveries, is replayed once
    // in canonical event-time order during startup.
    db.exec(`
      INSERT OR IGNORE INTO event_processing (event_id, incident_processed_at)
      SELECT events.id, events.receive_time
      FROM events
      WHERE EXISTS (
        SELECT 1 FROM incident_events
        WHERE incident_events.event_id = events.id
      );
    `);

    // Upgrade M7 databases where an unmatched recovery was already marked as
    // processed but had no durable reconciliation record.
    const unmatchedRecoveries = db.prepare(`
      ${GET_EVENT_SQL.replace('WHERE id = ?;', '')}
      WHERE type IN (
        'health.recovered',
        'host.memory_recovered',
        'host.disk_recovered'
      )
      AND NOT EXISTS (
        SELECT 1 FROM incident_events
        WHERE incident_events.event_id = events.id
      );
    `).all() as StoredEvent[];
    const insertPendingRecovery = db.prepare(INSERT_PENDING_RECOVERY_SQL);
    for (const stored of unmatchedRecoveries) {
      const event = mapStoredEvent(stored);
      insertPendingRecovery.run({
        event_id: event.id,
        fingerprint: computeFingerprint(event),
        event_time: event.time,
        event_json: JSON.stringify(event),
      });
    }

    db.exec(CREATE_EVIDENCE_TABLE_SQL);
    const evidenceColumns = new Set(
      (db.pragma('table_info(evidence)') as Array<{ name: string }>).map(({ name }) => name),
    );
    if (!evidenceColumns.has('failure_class')) {
      db.exec('ALTER TABLE evidence ADD COLUMN failure_class TEXT');
    }
    db.exec(CREATE_EVIDENCE_JOBS_TABLE_SQL);
    db.exec(CREATE_REASONING_RESULTS_TABLE_SQL);
    db.exec(CREATE_REASONING_JOBS_TABLE_SQL);
    db.exec(CREATE_REASONING_EVALUATIONS_TABLE_SQL);
    const evaluationColumns = new Set(
      (db.pragma('table_info(reasoning_evaluations)') as Array<{ name: string }>).map(({ name }) => name),
    );
    if (!evaluationColumns.has('confidence_score')) {
      db.exec('ALTER TABLE reasoning_evaluations ADD COLUMN confidence_score REAL');
    }
    if (!evaluationColumns.has('evidence_coverage_score')) {
      db.exec('ALTER TABLE reasoning_evaluations ADD COLUMN evidence_coverage_score REAL');
    }
    db.exec(CREATE_MEMORY_CANDIDATES_TABLE_SQL);
    db.exec(CREATE_MEMORY_ENTRIES_TABLE_SQL);
    db.exec(CREATE_MEMORY_FEEDBACKS_TABLE_SQL);
    db.exec(CREATE_INVESTIGATION_PLANS_TABLE_SQL);
    db.exec(CREATE_DELEGATION_TASKS_TABLE_SQL);
    db.exec(CREATE_INVESTIGATION_CONTEXT_SNAPSHOTS_TABLE_SQL);
    db.exec(CREATE_INVESTIGATION_SESSIONS_TABLE_SQL);
    db.exec(CREATE_INVESTIGATION_REPORTS_TABLE_SQL);
    const memoryCandidateColumns = new Set(
      (db.pragma('table_info(memory_candidates)') as Array<{ name: string }>).map(({ name }) => name),
    );
    if (!memoryCandidateColumns.has('source_evaluation_id')) {
      db.exec('ALTER TABLE memory_candidates ADD COLUMN source_evaluation_id TEXT');
    }
    const reasoningColumns = new Set(
      (db.pragma('table_info(reasoning_results)') as Array<{ name: string }>).map(({ name }) => name),
    );
    const reasoningResultColumns: Array<[string, string]> = [
      ['reasoning_job_id', 'TEXT'],
      ['reasoner_type', 'TEXT'],
      ['reasoner_version', 'TEXT'],
      ['evidence_ids', 'TEXT'],
      ['evidence_snapshot_hash', 'TEXT'],
      ['metadata_json', 'TEXT'],
    ];
    for (const [name, type] of reasoningResultColumns) {
      if (!reasoningColumns.has(name)) {
        db.exec(`ALTER TABLE reasoning_results ADD COLUMN ${name} ${type}`);
      }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reasoning_results_job
        ON reasoning_results (reasoning_job_id)
        WHERE reasoning_job_id IS NOT NULL;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_event_time ON events (event_time, id);
      CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint_state
        ON incidents (fingerprint, state, first_seen, last_seen);
    `);
  });
  try {
    migrateSchema();
  } catch (error) {
    db.close();
    throw error;
  }

  const insertStmt = db.prepare(INSERT_EVENT_SQL);
  const countStmt = db.prepare(COUNT_EVENTS_SQL);
  const getEventStmt = db.prepare(GET_EVENT_SQL);
  const getEventProcessedAtStmt = db.prepare(GET_EVENT_PROCESSED_AT_SQL);
  const listUnprocessedEventsStmt = db.prepare(LIST_UNPROCESSED_EVENTS_SQL);
  const markEventProcessedStmt = db.prepare(MARK_EVENT_PROCESSED_SQL);
  const insertPendingRecoveryStmt = db.prepare(INSERT_PENDING_RECOVERY_SQL);
  const listPendingRecoveriesStmt = db.prepare(LIST_PENDING_RECOVERIES_SQL);
  const listPendingRecoveryFingerprintsStmt = db.prepare(LIST_PENDING_RECOVERY_FINGERPRINTS_SQL);
  const deletePendingRecoveryStmt = db.prepare(DELETE_PENDING_RECOVERY_SQL);
  const countPendingRecoveriesStmt = db.prepare('SELECT COUNT(*) AS count FROM pending_recoveries');
  const listIncidentsByFingerprintStmt = db.prepare(LIST_INCIDENTS_BY_FINGERPRINT_SQL);
  const listActiveIncidentsStmt = db.prepare(LIST_ACTIVE_INCIDENTS_SQL);
  const findIncidentByEventIdStmt = db.prepare(FIND_INCIDENT_BY_EVENT_ID_SQL);
  const insertIncidentStmt = db.prepare(INSERT_INCIDENT_SQL);
  const updateIncidentStmt = db.prepare(UPDATE_INCIDENT_SQL);
  const linkEventStmt = db.prepare(LINK_EVENT_SQL);
  const countIncidentsStmt = db.prepare(COUNT_INCIDENTS_SQL);
  const insertEvidenceStmt = db.prepare(INSERT_EVIDENCE_SQL);
  const listEvidenceStmt = db.prepare(LIST_EVIDENCE_SQL);
  const countEvidenceStmt = db.prepare(COUNT_EVIDENCE_SQL);
  const insertEvidenceJobStmt = db.prepare(INSERT_EVIDENCE_JOB_SQL);
  const listPendingEvidenceJobsStmt = db.prepare(LIST_PENDING_EVIDENCE_JOBS_SQL);
  const markEvidenceJobRunningStmt = db.prepare(MARK_EVIDENCE_JOB_RUNNING_SQL);
  const markEvidenceJobCompletedStmt = db.prepare(MARK_EVIDENCE_JOB_COMPLETED_SQL);
  const markEvidenceJobRetryStmt = db.prepare(MARK_EVIDENCE_JOB_RETRY_SQL);
  const resetRunningEvidenceJobsStmt = db.prepare(RESET_RUNNING_EVIDENCE_JOBS_SQL);
  const getEvidenceJobStmt = db.prepare('SELECT * FROM evidence_jobs WHERE id = ?');
  const requeueEvidenceJobStmt = db.prepare(REQUEUE_EVIDENCE_JOB_SQL);
  const insertReasoningResultStmt = db.prepare(`
INSERT OR IGNORE INTO reasoning_results (
  id, incident_id, created_at, hypotheses_json, missing_evidence_json, confidence, status,
  reasoning_job_id, reasoner_type, reasoner_version, evidence_ids, evidence_snapshot_hash,
  metadata_json
) VALUES (
  @id, @incident_id, @created_at, @hypotheses_json, @missing_evidence_json, @confidence, @status,
  @reasoning_job_id, @reasoner_type, @reasoner_version, @evidence_ids, @evidence_snapshot_hash,
  @metadata_json
);
`);
  const listReasoningResultsStmt = db.prepare(`
SELECT * FROM reasoning_results WHERE incident_id = ? ORDER BY created_at, id;
`);
  const insertReasoningJobStmt = db.prepare(INSERT_REASONING_JOB_SQL);
  const listPendingReasoningJobsStmt = db.prepare(LIST_PENDING_REASONING_JOBS_SQL);
  const markReasoningJobRunningStmt = db.prepare(MARK_REASONING_JOB_RUNNING_SQL);
  const markReasoningJobCompletedStmt = db.prepare(MARK_REASONING_JOB_COMPLETED_SQL);
  const markReasoningJobFailedStmt = db.prepare(MARK_REASONING_JOB_FAILED_SQL);
  const markReasoningJobWaitingDelegationStmt = db.prepare(MARK_REASONING_JOB_WAITING_DELEGATION_SQL);
  const resetRunningReasoningJobsStmt = db.prepare(RESET_RUNNING_REASONING_JOBS_SQL);
  const getReasoningJobStmt = db.prepare('SELECT * FROM reasoning_jobs WHERE id = ?');
  const getReasoningResultByJobStmt = db.prepare(
    'SELECT * FROM reasoning_results WHERE reasoning_job_id = ?',
  );
  const getReasoningResultStmt = db.prepare('SELECT * FROM reasoning_results WHERE id = ?');
  const insertReasoningEvaluationStmt = db.prepare(`
INSERT INTO reasoning_evaluations (
  id, reasoning_result_id, evaluator_type, score, confidence_score, evidence_coverage_score, feedback, created_at
) VALUES (
  @id, @reasoning_result_id, @evaluator_type, @score, @confidence_score, @evidence_coverage_score, @feedback, @created_at
);
`);
  const listReasoningEvaluationsStmt = db.prepare(`
SELECT * FROM reasoning_evaluations
WHERE reasoning_result_id = ?
ORDER BY created_at, id;
`);
  const insertMemoryCandidateStmt = db.prepare(`
INSERT INTO memory_candidates (
  id, source_reasoning_result_id, source_evaluation_id, incident_type, pattern, evidence_summary,
  conclusion, resolution, confidence, status, created_at
) VALUES (
  @id, @source_reasoning_result_id, @source_evaluation_id, @incident_type, @pattern, @evidence_summary,
  @conclusion, @resolution, @confidence, @status, @created_at
);
`);
  const listMemoryCandidatesStmt = db.prepare(`
SELECT * FROM memory_candidates
WHERE (@source_reasoning_result_id IS NULL OR source_reasoning_result_id = @source_reasoning_result_id)
ORDER BY created_at, id;
`);
  const getMemoryCandidateStmt = db.prepare('SELECT * FROM memory_candidates WHERE id = ?');
  const updateMemoryCandidateStatusStmt = db.prepare(`
UPDATE memory_candidates SET status = @status WHERE id = @id;
`);
  const getReasoningEvaluationStmt = db.prepare('SELECT * FROM reasoning_evaluations WHERE id = ?');
  const insertMemoryEntryStmt = db.prepare(`
INSERT INTO memory_entries (
  id, source_memory_candidate_id, source_evaluation_id, pattern, evidence_summary,
  conclusion, resolution, confidence, status, created_at, approved_at
) VALUES (
  @id, @source_memory_candidate_id, @source_evaluation_id, @pattern, @evidence_summary,
  @conclusion, @resolution, @confidence, @status, @created_at, @approved_at
);
`);
  const getMemoryEntryStmt = db.prepare('SELECT * FROM memory_entries WHERE id = ?');
  const getMemoryEntryByCandidateStmt = db.prepare(
    'SELECT * FROM memory_entries WHERE source_memory_candidate_id = ?',
  );
  const listActiveMemoryEntriesStmt = db.prepare(`
SELECT * FROM memory_entries WHERE status = 'ACTIVE' ORDER BY created_at, id;
`);
  const updateMemoryEntryStatusStmt = db.prepare(`
UPDATE memory_entries SET status = @status WHERE id = @id;
`);
  const insertMemoryFeedbackStmt = db.prepare(`
INSERT INTO memory_feedbacks (
  id, memory_entry_id, incident_id, reasoning_result_id, outcome, effectiveness_score, created_at
) VALUES (
  @id, @memory_entry_id, @incident_id, @reasoning_result_id, @outcome, @effectiveness_score, @created_at
);
`);
  const listMemoryFeedbacksStmt = db.prepare(`
SELECT * FROM memory_feedbacks
WHERE memory_entry_id = ?
ORDER BY created_at, id;
`);
  const insertInvestigationPlanStmt = db.prepare(`
INSERT INTO investigation_plans (
  id, reasoning_job_id, strategy, objectives_json, requested_capabilities_json, created_at
) VALUES (
  @id, @reasoning_job_id, @strategy, @objectives_json, @requested_capabilities_json, @created_at
);
`);
  const getInvestigationPlanStmt = db.prepare('SELECT * FROM investigation_plans WHERE id = ?');
  const listInvestigationPlansByJobStmt = db.prepare(`
SELECT * FROM investigation_plans WHERE reasoning_job_id = ? ORDER BY created_at, id;
`);
  const insertDelegationTaskStmt = db.prepare(`
INSERT INTO delegation_tasks (
  id, investigation_plan_id, status, submitted_at, completed_at, runtime_task_id, last_error
) VALUES (
  @id, @investigation_plan_id, @status, @submitted_at, @completed_at, @runtime_task_id, @last_error
);
`);
  const getDelegationTaskStmt = db.prepare('SELECT * FROM delegation_tasks WHERE id = ?');
  const getDelegationTaskByPlanStmt = db.prepare(
    'SELECT * FROM delegation_tasks WHERE investigation_plan_id = ?',
  );
  const markDelegationTaskSubmittedStmt = db.prepare(`
UPDATE delegation_tasks
SET status = 'SUBMITTED', submitted_at = @submitted_at, runtime_task_id = @runtime_task_id, last_error = NULL
WHERE id = @id;
`);
  const markDelegationTaskCompletedStmt = db.prepare(`
UPDATE delegation_tasks
SET status = 'COMPLETED', completed_at = @completed_at, last_error = NULL
WHERE id = @id;
`);
  const markDelegationTaskFailedStmt = db.prepare(`
UPDATE delegation_tasks
SET status = 'FAILED', last_error = @last_error
WHERE id = @id;
`);
  const insertInvestigationContextSnapshotStmt = db.prepare(`
INSERT OR IGNORE INTO investigation_context_snapshots (hash, context_json, created_at)
VALUES (@hash, @context_json, @created_at);
`);
  const getInvestigationContextSnapshotStmt = db.prepare(
    'SELECT * FROM investigation_context_snapshots WHERE hash = ?',
  );
  const insertInvestigationSessionStmt = db.prepare(`
INSERT INTO investigation_sessions (
  id, incident_id, context_snapshot_hash, delegation_task_id, status, created_at, completed_at
) VALUES (
  @id, @incident_id, @context_snapshot_hash, @delegation_task_id, @status, @created_at, @completed_at
);
`);
  const getInvestigationSessionStmt = db.prepare('SELECT * FROM investigation_sessions WHERE id = ?');
  const updateInvestigationSessionStatusStmt = db.prepare(`
UPDATE investigation_sessions
SET status = @status, completed_at = COALESCE(@completed_at, completed_at)
WHERE id = @id;
`);
  const insertInvestigationReportStmt = db.prepare(`
INSERT INTO investigation_reports (
  id, session_id, hypothesis, supporting_evidence_ids_json, contradicting_evidence_ids_json,
  confidence, recommendation, created_at
) VALUES (
  @id, @session_id, @hypothesis, @supporting_evidence_ids_json, @contradicting_evidence_ids_json,
  @confidence, @recommendation, @created_at
);
`);
  const getInvestigationReportStmt = db.prepare('SELECT * FROM investigation_reports WHERE id = ?');
  const getInvestigationReportBySessionStmt = db.prepare(
    'SELECT * FROM investigation_reports WHERE session_id = ?',
  );

  function mapEvidenceJob(row: EvidenceJobRow): EvidenceJob {
    return {
      id: row.id,
      incidentId: row.incident_id,
      triggeringEvent: JSON.parse(row.event_json) as OpsEvent,
      state: row.state,
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapReasoningJob(row: ReasoningJobRow): ReasoningJob {
    return {
      id: row.id,
      incidentId: row.incident_id,
      reasonerType: row.reasoner_type,
      reasonerVersion: row.reasoner_version,
      status: row.status,
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapReasoningResult(row: {
    id: string;
    incident_id: string;
    created_at: string;
    hypotheses_json: string;
    missing_evidence_json: string;
    confidence: number;
    status: ReasoningResult['status'];
    reasoning_job_id: string | null;
    reasoner_type: string | null;
    reasoner_version: string | null;
    evidence_ids: string | null;
    evidence_snapshot_hash: string | null;
    metadata_json: string | null;
  }): ReasoningResult {
    const metadata = parseReasoningMetadata(row.metadata_json);
    return {
      id: row.id,
      incidentId: row.incident_id,
      createdAt: row.created_at,
      hypotheses: JSON.parse(row.hypotheses_json) as string[],
      missingEvidence: JSON.parse(row.missing_evidence_json) as string[],
      confidence: row.confidence,
      status: row.status,
      ...(row.reasoning_job_id ? { reasoningJobId: row.reasoning_job_id } : {}),
      ...(row.reasoner_type ? { reasonerType: row.reasoner_type } : {}),
      ...(row.reasoner_version ? { reasonerVersion: row.reasoner_version } : {}),
      ...(row.evidence_ids ? { evidenceIds: JSON.parse(row.evidence_ids) as string[] } : {}),
      ...(row.evidence_snapshot_hash ? { evidenceSnapshotHash: row.evidence_snapshot_hash } : {}),
      ...metadata,
    };
  }

  function insertIncident(id: string, incident: Omit<IncidentRow, 'id'>): void {
    insertIncidentStmt.run({
      id,
      service: incident.service,
      node_id: incident.node_id,
      type: incident.type,
      state: incident.state,
      fingerprint: incident.fingerprint,
      first_seen: incident.first_seen,
      last_seen: incident.last_seen,
      event_count: incident.event_count,
      severity: incident.severity,
    });
  }

  function mapStoredEvent(stored: StoredEvent): OpsEvent {
    return {
      schemaVersion: stored.schema_version as 1,
      id: stored.id,
      time: stored.event_time,
      source: stored.source as OpsEvent['source'],
      nodeId: stored.node_id,
      service: stored.service,
      type: stored.type,
      severity: stored.severity as OpsEvent['severity'],
      ...(stored.fingerprint !== null ? { fingerprint: stored.fingerprint } : {}),
      ...(stored.trace_id !== null ? { traceId: stored.trace_id } : {}),
      message: stored.message,
      attributes: JSON.parse(stored.attributes) as Record<string, unknown>,
    };
  }

  function storedEventMatches(
    batch: EventBatch,
    event: OpsEvent,
    stored: StoredEvent,
  ): boolean {
    return stored.schema_version === event.schemaVersion
      && stored.event_time === event.time
      && stored.producer_id === batch.producer.id
      && stored.producer_type === batch.producer.type
      && stored.source === event.source
      && stored.node_id === event.nodeId
      && stored.service === event.service
      && stored.type === event.type
      && stored.severity === event.severity
      && stored.fingerprint === (event.fingerprint ?? null)
      && stored.trace_id === (event.traceId ?? null)
      && stored.message === event.message
      && isDeepStrictEqual(
        JSON.parse(stored.attributes),
        JSON.parse(JSON.stringify(event.attributes)),
      );
  }

  function insertOrValidateEventRow(
    batch: EventBatch,
    event: OpsEvent,
    receiveTime: string,
  ): { inserted: boolean; stored?: StoredEvent } {
    const result = insertStmt.run({
      id: event.id,
      schema_version: event.schemaVersion,
      event_time: event.time,
      receive_time: receiveTime,
      producer_id: batch.producer.id,
      producer_type: batch.producer.type,
      producer_version: batch.producer.version,
      source: event.source,
      node_id: event.nodeId,
      service: event.service,
      type: event.type,
      severity: event.severity,
      fingerprint: event.fingerprint ?? null,
      trace_id: event.traceId ?? null,
      message: event.message,
      attributes: JSON.stringify(event.attributes),
    });
    if (result.changes === 1) return { inserted: true };

    const stored = getEventStmt.get(event.id) as StoredEvent | undefined;
    if (!stored || !storedEventMatches(batch, event, stored)) {
      throw new DuplicateEventConflictError(event.id);
    }
    return { inserted: false, stored };
  }

  function insertEventRows(batch: EventBatch, receiveTime: string): number {
    let inserted = 0;
    for (const event of batch.events) {
      if (insertOrValidateEventRow(batch, event, receiveTime).inserted) inserted++;
    }
    return inserted;
  }

  const insertBatchTransaction = db.transaction(insertEventRows);
  const processBatchTransaction = db.transaction((
    batch: EventBatch,
    receiveTime: string,
    processEvent: (event: OpsEvent) => { isNew: boolean },
  ): ProcessBatchResult => {
    let inserted = 0;
    let processed = 0;
    let createdIncidents = 0;
    const pending = new Map<string, OpsEvent>();

    // Validate the complete batch before invoking Incident processing. A single
    // conflicting immutable id rejects the transaction without partial state
    // transitions or callback side effects.
    for (const event of batch.events) {
      const persisted = insertOrValidateEventRow(batch, event, receiveTime);
      if (persisted.inserted) inserted++;
      if (!pending.has(event.id)) pending.set(event.id, event);
    }

    for (const event of pending.values()) {
      if (getEventProcessedAtStmt.get(event.id)) continue;
      const result = processEvent(event);
      if (result.isNew) createdIncidents++;
      const marked = markEventProcessedStmt.run({
        id: event.id,
        processed_at: receiveTime,
      });
      if (marked.changes !== 1 && !getEventProcessedAtStmt.get(event.id)) {
        throw new Error(`Event ${event.id} could not be marked as Incident-processed`);
      }
      processed++;
    }
    return { inserted, processed, createdIncidents };
  });

  const replayPendingEventsTransaction = db.transaction((
    processEvent: (event: OpsEvent) => void,
    processedAt: string,
    limit: number,
  ): number => {
    const pending = listUnprocessedEventsStmt.all({ limit }) as StoredEvent[];
    for (const stored of pending) {
      const event = mapStoredEvent(stored);
      processEvent(event);
      const marked = markEventProcessedStmt.run({ id: event.id, processed_at: processedAt });
      if (marked.changes !== 1 && !getEventProcessedAtStmt.get(event.id)) {
        throw new Error(`Event ${event.id} could not be marked as Incident-processed`);
      }
    }
    return pending.length;
  });

  const createIncidentFromEventTransaction = db.transaction((
    incident: Omit<IncidentRow, 'id'>,
    event: OpsEvent,
    reasoning: { reasonerType: string; reasonerVersion: string },
  ): IncidentRow => {
    const id = generateId('inc');
    insertIncident(id, incident);
    const link = linkEventStmt.run({ incident_id: id, event_id: event.id });
    if (link.changes !== 1) {
      throw new Error(`Event ${event.id} is already linked to an Incident`);
    }
    const now = new Date().toISOString();
    insertEvidenceJobStmt.run({
      id: `job-${id}`,
      incident_id: id,
      event_json: JSON.stringify(event),
      created_at: now,
      updated_at: now,
    });
    insertReasoningJobStmt.run({
      id: `rj-${id}`,
      incident_id: id,
      reasoner_type: reasoning.reasonerType,
      reasoner_version: reasoning.reasonerVersion,
      created_at: now,
      updated_at: now,
    });
    return { id, ...incident };
  });

  function laterTimestamp(a: string, b: string): string {
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  }

  const store: EventStore = {
    // ── Events ────────────────────────────────────────────────────────────

    insertBatch(batch: EventBatch, receiveTime: string): number {
      return insertBatchTransaction(batch, receiveTime);
    },

    processBatch(
      batch: EventBatch,
      receiveTime: string,
      processEvent: (event: OpsEvent) => { isNew: boolean },
    ): ProcessBatchResult {
      return processBatchTransaction(batch, receiveTime, processEvent);
    },

    count(): number {
      const row = countStmt.get() as { count: number };
      return row.count;
    },

    getEvent(id: string): StoredEvent | undefined {
      return getEventStmt.get(id) as StoredEvent | undefined;
    },

    getEventProcessedAt(id: string): string | undefined {
      const row = getEventProcessedAtStmt.get(id) as
        | { incident_processed_at: string }
        | undefined;
      return row?.incident_processed_at;
    },

    markEventProcessed(id: string, processedAt: string): void {
      markEventProcessedStmt.run({ id, processed_at: processedAt });
    },

    replayPendingEvents(
      processEvent: (event: OpsEvent) => void,
      processedAt: string,
      limit: number,
    ): number {
      return replayPendingEventsTransaction(processEvent, processedAt, limit);
    },

    // ── Incidents ─────────────────────────────────────────────────────────

    addPendingRecovery(event: OpsEvent, fingerprint: string): void {
      insertPendingRecoveryStmt.run({
        event_id: event.id,
        fingerprint,
        event_time: event.time,
        event_json: JSON.stringify(event),
      });
    },

    listPendingRecoveries(fingerprint: string): OpsEvent[] {
      const rows = listPendingRecoveriesStmt.all({ fingerprint }) as Array<{
        event_json: string;
      }>;
      return rows.map((row) => JSON.parse(row.event_json) as OpsEvent);
    },

    listPendingRecoveryFingerprints(): string[] {
      const rows = listPendingRecoveryFingerprintsStmt.all() as Array<{ fingerprint: string }>;
      return rows.map((row) => row.fingerprint);
    },

    removePendingRecovery(eventId: string): void {
      deletePendingRecoveryStmt.run(eventId);
    },

    applyRecovery(incidentId: string, recovery: OpsEvent): boolean {
      return applyRecoveryTransaction(incidentId, recovery);
    },

    pendingRecoveryCount(): number {
      const row = countPendingRecoveriesStmt.get() as { count: number };
      return row.count;
    },

    findActiveIncident(
      fingerprint: string,
      timestamp: string,
      aggregationWindowMs: number,
    ): IncidentRow | undefined {
      const eventTime = new Date(timestamp).getTime();
      const rows = listActiveIncidentsStmt.all({ fingerprint }) as IncidentRow[];
      return rows
        .map((incident) => {
          const firstSeen = new Date(incident.first_seen).getTime();
          const lastSeen = new Date(incident.last_seen).getTime();
          const distance = eventTime < firstSeen
            ? firstSeen - eventTime
            : eventTime > lastSeen
              ? eventTime - lastSeen
              : 0;
          return { incident, distance, firstSeen };
        })
        .filter(({ distance }) => distance <= aggregationWindowMs)
        .sort((a, b) =>
          a.distance - b.distance
          || b.firstSeen - a.firstSeen
          || a.incident.id.localeCompare(b.incident.id),
        )[0]?.incident;
    },

    findRecoveryIncident(fingerprint: string, timestamp: string): IncidentRow | undefined {
      const recoveryTime = new Date(timestamp).getTime();
      const rows = listActiveIncidentsStmt.all({ fingerprint }) as IncidentRow[];
      const candidates = rows.filter((incident) => {
        const firstSeen = new Date(incident.first_seen).getTime();
        const lastSeen = new Date(incident.last_seen).getTime();
        return firstSeen <= recoveryTime && lastSeen <= recoveryTime;
      });

      // Event time cannot distinguish multiple still-active episodes with the
      // same central fingerprint. Fail closed instead of recovering the wrong
      // Incident; a later explicit/manual correlation can resolve ambiguity.
      return candidates.length === 1 ? candidates[0] : undefined;
    },

    findIncidentForEvent(
      fingerprint: string,
      timestamp: string,
      aggregationWindowMs: number,
    ): IncidentRow | undefined {
      const eventTime = new Date(timestamp).getTime();
      const rows = listIncidentsByFingerprintStmt.all({ fingerprint }) as IncidentRow[];
      const candidates: Array<{
        incident: IncidentRow;
        distance: number;
        firstSeen: number;
      }> = [];

      for (const incident of rows) {
        const firstSeen = new Date(incident.first_seen).getTime();
        const lastSeen = new Date(incident.last_seen).getTime();
        const active = incident.state === 'OPEN'
          || incident.state === 'INVESTIGATING'
          || incident.state === 'NOTIFIED';

        // CLOSED is administratively terminal and is never mutated. RECOVERED
        // may absorb only a genuinely historical Event at or before recovery.
        if (incident.state === 'CLOSED') continue;
        if (!active && eventTime > lastSeen) continue;

        const distance = eventTime < firstSeen
          ? firstSeen - eventTime
          : eventTime > lastSeen
            ? eventTime - lastSeen
            : 0;
        if (distance <= aggregationWindowMs) {
          candidates.push({ incident, distance, firstSeen });
        }
      }

      return candidates.sort((a, b) =>
        a.distance - b.distance
        || b.firstSeen - a.firstSeen
        || a.incident.id.localeCompare(b.incident.id),
      )[0]?.incident;
    },

    findIncidentByEventId(eventId: string): IncidentRow | undefined {
      return findIncidentByEventIdStmt.get(eventId) as IncidentRow | undefined;
    },

    createIncident(incident: Omit<IncidentRow, 'id'>): IncidentRow {
      const id = generateId('inc');
      insertIncident(id, incident);
      return { id, ...incident };
    },

    createIncidentFromEvent(
      incident: Omit<IncidentRow, 'id'>,
      event: OpsEvent,
      reasoning: { reasonerType: string; reasonerVersion: string } = {
        reasonerType: 'fake',
        reasonerVersion: '1',
      },
    ): IncidentRow {
      return createIncidentFromEventTransaction(incident, event, reasoning);
    },

    updateIncident(id: string, updates: {
      first_seen: string;
      last_seen: string;
      event_count: number;
      severity: string;
      state: IncidentState;
    }): void {
      updateIncidentStmt.run({
        id,
        first_seen: updates.first_seen,
        last_seen: updates.last_seen,
        event_count: updates.event_count,
        severity: updates.severity,
        state: updates.state,
      });
    },

    linkEventToIncident(incidentId: string, eventId: string): boolean {
      const result = linkEventStmt.run({ incident_id: incidentId, event_id: eventId });
      return result.changes > 0;
    },

    incidentCount(): number {
      const row = countIncidentsStmt.get() as { count: number };
      return row.count;
    },

    getIncident(id: string): IncidentRow | undefined {
      return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined;
    },

    // ── Evidence ──────────────────────────────────────────────────────────

    insertEvidence(evidence: EvidenceRecord): void {
      insertEvidenceStmt.run({
        id: evidence.id,
        incident_id: evidence.incidentId,
        node_id: evidence.nodeId,
        source: evidence.source,
        kind: evidence.kind,
        collected_at: evidence.collectedAt,
        status: evidence.status,
        data_json: JSON.stringify(evidence.data ?? null),
        error: evidence.error ?? null,
        failure_class: evidence.failureClass ?? null,
      });
    },

    listEvidence(incidentId: string): EvidenceRecord[] {
      const rows = listEvidenceStmt.all(incidentId) as EvidenceRow[];
      return rows.map((row) => ({
        id: row.id,
        incidentId: row.incident_id,
        nodeId: row.node_id,
        source: row.source,
        kind: row.kind,
        collectedAt: row.collected_at,
        data: JSON.parse(row.data_json) as unknown,
        status: row.status,
        ...(row.error ? { error: row.error } : {}),
        ...(row.failure_class ? { failureClass: row.failure_class } : {}),
      }));
    },

    evidenceCount(): number {
      const row = countEvidenceStmt.get() as { count: number };
      return row.count;
    },

    // ── Durable evidence jobs ─────────────────────────────────────────────

    listPendingEvidenceJobs(limit: number): EvidenceJob[] {
      const rows = listPendingEvidenceJobsStmt.all(limit) as EvidenceJobRow[];
      return rows.map(mapEvidenceJob);
    },

    markEvidenceJobRunning(id: string): boolean {
      const result = markEvidenceJobRunningStmt.run({
        id,
        updated_at: new Date().toISOString(),
      });
      return result.changes > 0;
    },

    markEvidenceJobCompleted(id: string): void {
      markEvidenceJobCompletedStmt.run({ id, updated_at: new Date().toISOString() });
    },

    markEvidenceJobRetry(id: string, error: string, failed: boolean): void {
      markEvidenceJobRetryStmt.run({
        id,
        state: failed ? 'FAILED' : 'PENDING',
        last_error: error,
        updated_at: new Date().toISOString(),
      });
    },

    resetRunningEvidenceJobs(): number {
      const result = resetRunningEvidenceJobsStmt.run(new Date().toISOString());
      return result.changes;
    },

    getEvidenceJob(id: string): EvidenceJob | undefined {
      const row = getEvidenceJobStmt.get(id) as EvidenceJobRow | undefined;
      return row ? mapEvidenceJob(row) : undefined;
    },

    requeueEvidenceJob(incidentId: string, event: OpsEvent): boolean {
      const result = requeueEvidenceJobStmt.run({
        incident_id: incidentId,
        event_json: JSON.stringify(event),
        updated_at: new Date().toISOString(),
      });
      return result.changes > 0;
    },

    createReasoningJob(job: {
      id: string;
      incidentId: string;
      reasonerType: string;
      reasonerVersion: string;
      createdAt: string;
    }): void {
      insertReasoningJobStmt.run({
        id: job.id,
        incident_id: job.incidentId,
        reasoner_type: job.reasonerType,
        reasoner_version: job.reasonerVersion,
        created_at: job.createdAt,
        updated_at: job.createdAt,
      });
    },

    listPendingReasoningJobs(limit: number): ReasoningJob[] {
      const rows = listPendingReasoningJobsStmt.all(limit) as ReasoningJobRow[];
      return rows.map(mapReasoningJob);
    },

    markReasoningJobRunning(id: string): boolean {
      const result = markReasoningJobRunningStmt.run({
        id,
        updated_at: new Date().toISOString(),
      });
      return result.changes > 0;
    },

    markReasoningJobCompleted(id: string): void {
      markReasoningJobCompletedStmt.run({ id, updated_at: new Date().toISOString() });
    },

    markReasoningJobFailed(id: string, error: string): void {
      markReasoningJobFailedStmt.run({
        id,
        last_error: error,
        updated_at: new Date().toISOString(),
      });
    },

    markReasoningJobWaitingDelegation(id: string): void {
      markReasoningJobWaitingDelegationStmt.run({
        id,
        updated_at: new Date().toISOString(),
      });
    },

    resetRunningReasoningJobs(): number {
      const result = resetRunningReasoningJobsStmt.run(new Date().toISOString());
      return result.changes;
    },

    getReasoningJob(id: string): ReasoningJob | undefined {
      const row = getReasoningJobStmt.get(id) as ReasoningJobRow | undefined;
      return row ? mapReasoningJob(row) : undefined;
    },

    insertReasoningResult(result: ReasoningResult): boolean {
      const inserted = insertReasoningResultStmt.run({
        id: result.id,
        incident_id: result.incidentId,
        created_at: result.createdAt,
        hypotheses_json: JSON.stringify(result.hypotheses),
        missing_evidence_json: JSON.stringify(result.missingEvidence),
        confidence: result.confidence,
        status: result.status,
        reasoning_job_id: result.reasoningJobId ?? null,
        reasoner_type: result.reasonerType ?? null,
        reasoner_version: result.reasonerVersion ?? null,
        evidence_ids: result.evidenceIds ? JSON.stringify(result.evidenceIds) : null,
        evidence_snapshot_hash: result.evidenceSnapshotHash ?? null,
        metadata_json: serializeReasoningMetadata(result),
      });
      return inserted.changes > 0;
    },

    listReasoningResults(incidentId: string): ReasoningResult[] {
      return (listReasoningResultsStmt.all(incidentId) as Array<Parameters<typeof mapReasoningResult>[0]>)
        .map(mapReasoningResult);
    },

    getReasoningResult(id: string): ReasoningResult | undefined {
      const row = getReasoningResultStmt.get(id) as Parameters<typeof mapReasoningResult>[0] | undefined;
      return row ? mapReasoningResult(row) : undefined;
    },

    getReasoningResultByJobId(jobId: string): ReasoningResult | undefined {
      const row = getReasoningResultByJobStmt.get(jobId) as Parameters<typeof mapReasoningResult>[0] | undefined;
      return row ? mapReasoningResult(row) : undefined;
    },

    insertReasoningEvaluation(evaluation: ReasoningEvaluation): void {
      insertReasoningEvaluationStmt.run({
        id: evaluation.id,
        reasoning_result_id: evaluation.reasoningResultId,
        evaluator_type: evaluation.evaluatorType,
        score: evaluation.score,
        confidence_score: evaluation.confidenceScore,
        evidence_coverage_score: evaluation.evidenceCoverageScore,
        feedback: evaluation.feedback,
        created_at: evaluation.createdAt,
      });
    },

    listReasoningEvaluations(reasoningResultId: string): ReasoningEvaluation[] {
      const rows = listReasoningEvaluationsStmt.all(reasoningResultId) as EvaluationRow[];
      return rows.map(mapEvaluationRow);
    },

    insertMemoryCandidate(candidate: MemoryCandidate): void {
      if (!candidate.sourceEvaluationId) {
        throw new Error('MemoryCandidate requires a sourceEvaluationId');
      }
      insertMemoryCandidateStmt.run({
        id: candidate.id,
        source_reasoning_result_id: candidate.sourceReasoningResultId,
        source_evaluation_id: candidate.sourceEvaluationId,
        incident_type: candidate.incidentType,
        pattern: candidate.pattern,
        evidence_summary: candidate.evidenceSummary,
        conclusion: candidate.conclusion,
        resolution: candidate.resolution,
        confidence: candidate.confidence,
        status: candidate.status,
        created_at: candidate.createdAt,
      });
    },

    listMemoryCandidates(sourceReasoningResultId?: string): MemoryCandidate[] {
      const rows = listMemoryCandidatesStmt.all({
        source_reasoning_result_id: sourceReasoningResultId ?? null,
      }) as MemoryCandidateRow[];
      return rows.map(mapMemoryCandidateRow);
    },

    getMemoryCandidate(id: string): MemoryCandidate | undefined {
      const row = getMemoryCandidateStmt.get(id) as MemoryCandidateRow | undefined;
      return row ? mapMemoryCandidateRow(row) : undefined;
    },

    updateMemoryCandidateStatus(id: string, status: MemoryCandidate['status']): void {
      updateMemoryCandidateStatusStmt.run({ id, status });
    },

    getReasoningEvaluation(id: string): ReasoningEvaluation | undefined {
      const row = getReasoningEvaluationStmt.get(id) as EvaluationRow | undefined;
      return row ? mapEvaluationRow(row) : undefined;
    },

    insertMemoryEntry(entry: MemoryEntry): void {
      insertMemoryEntryStmt.run({
        id: entry.id,
        source_memory_candidate_id: entry.sourceMemoryCandidateId,
        source_evaluation_id: entry.sourceEvaluationId,
        pattern: entry.pattern,
        evidence_summary: entry.evidenceSummary,
        conclusion: entry.conclusion,
        resolution: entry.resolution,
        confidence: entry.confidence,
        status: entry.status,
        created_at: entry.createdAt,
        approved_at: entry.approvedAt,
      });
    },

    getMemoryEntry(id: string): MemoryEntry | undefined {
      const row = getMemoryEntryStmt.get(id) as MemoryEntryRow | undefined;
      return row ? mapMemoryEntryRow(row) : undefined;
    },

    getMemoryEntryByCandidateId(candidateId: string): MemoryEntry | undefined {
      const row = getMemoryEntryByCandidateStmt.get(candidateId) as MemoryEntryRow | undefined;
      return row ? mapMemoryEntryRow(row) : undefined;
    },

    listActiveMemoryEntries(): MemoryEntry[] {
      return (listActiveMemoryEntriesStmt.all() as MemoryEntryRow[]).map(mapMemoryEntryRow);
    },

    updateMemoryEntryStatus(id: string, status: MemoryEntry['status']): void {
      updateMemoryEntryStatusStmt.run({ id, status });
    },

    insertMemoryFeedback(feedback: MemoryFeedback): void {
      insertMemoryFeedbackStmt.run({
        id: feedback.id,
        memory_entry_id: feedback.memoryEntryId,
        incident_id: feedback.incidentId,
        reasoning_result_id: feedback.reasoningResultId ?? null,
        outcome: feedback.outcome,
        effectiveness_score: feedback.effectivenessScore,
        created_at: feedback.createdAt,
      });
    },

    listMemoryFeedbacks(memoryEntryId: string): MemoryFeedback[] {
      return (listMemoryFeedbacksStmt.all(memoryEntryId) as MemoryFeedbackRow[]).map(mapMemoryFeedbackRow);
    },

    insertInvestigationPlan(plan: InvestigationPlan): void {
      insertInvestigationPlanStmt.run({
        id: plan.id,
        reasoning_job_id: plan.reasoningJobId,
        strategy: plan.strategy,
        objectives_json: JSON.stringify(plan.objectives),
        requested_capabilities_json: JSON.stringify(plan.requestedCapabilities),
        created_at: plan.createdAt,
      });
    },

    getInvestigationPlan(id: string): InvestigationPlan | undefined {
      const row = getInvestigationPlanStmt.get(id) as InvestigationPlanRow | undefined;
      return row ? mapInvestigationPlanRow(row) : undefined;
    },

    listInvestigationPlansByJob(reasoningJobId: string): InvestigationPlan[] {
      return (listInvestigationPlansByJobStmt.all(reasoningJobId) as InvestigationPlanRow[])
        .map(mapInvestigationPlanRow);
    },

    insertDelegationTask(task: DelegationTask): void {
      insertDelegationTaskStmt.run({
        id: task.id,
        investigation_plan_id: task.investigationPlanId,
        status: task.status,
        submitted_at: task.submittedAt ?? null,
        completed_at: task.completedAt ?? null,
        runtime_task_id: task.runtimeTaskId ?? null,
        last_error: task.lastError ?? null,
      });
    },

    getDelegationTask(id: string): DelegationTask | undefined {
      const row = getDelegationTaskStmt.get(id) as DelegationTaskRow | undefined;
      return row ? mapDelegationTaskRow(row) : undefined;
    },

    getDelegationTaskByPlanId(planId: string): DelegationTask | undefined {
      const row = getDelegationTaskByPlanStmt.get(planId) as DelegationTaskRow | undefined;
      return row ? mapDelegationTaskRow(row) : undefined;
    },

    markDelegationTaskSubmitted(id: string, submittedAt: string, runtimeTaskId?: string): void {
      markDelegationTaskSubmittedStmt.run({
        id,
        submitted_at: submittedAt,
        runtime_task_id: runtimeTaskId ?? null,
      });
    },

    markDelegationTaskCompleted(id: string, completedAt: string): void {
      markDelegationTaskCompletedStmt.run({ id, completed_at: completedAt });
    },

    markDelegationTaskFailed(id: string, error: string): void {
      markDelegationTaskFailedStmt.run({ id, last_error: error });
    },

    insertInvestigationContextSnapshot(hash: string, context: InvestigationContext, createdAt: string): void {
      insertInvestigationContextSnapshotStmt.run({
        hash,
        context_json: JSON.stringify(context),
        created_at: createdAt,
      });
    },

    getInvestigationContextSnapshot(hash: string): InvestigationContext | undefined {
      const row = getInvestigationContextSnapshotStmt.get(hash) as
        | { hash: string; context_json: string; created_at: string }
        | undefined;
      if (!row) return undefined;
      return freezeSnapshot(JSON.parse(row.context_json) as InvestigationContext);
    },

    insertInvestigationSession(session: InvestigationSession): void {
      insertInvestigationSessionStmt.run({
        id: session.id,
        incident_id: session.incidentId,
        context_snapshot_hash: session.contextSnapshotHash,
        delegation_task_id: session.delegationTaskId,
        status: session.status,
        created_at: session.createdAt,
        completed_at: session.completedAt ?? null,
      });
    },

    getInvestigationSession(id: string): InvestigationSession | undefined {
      const row = getInvestigationSessionStmt.get(id) as InvestigationSessionRow | undefined;
      return row ? mapInvestigationSessionRow(row) : undefined;
    },

    updateInvestigationSessionStatus(
      id: string,
      status: InvestigationSession['status'],
      completedAt?: string,
    ): void {
      updateInvestigationSessionStatusStmt.run({
        id,
        status,
        completed_at: completedAt ?? null,
      });
    },

    insertInvestigationReport(report: InvestigationReport): void {
      insertInvestigationReportStmt.run({
        id: report.id,
        session_id: report.sessionId,
        hypothesis: report.hypothesis,
        supporting_evidence_ids_json: JSON.stringify(report.supportingEvidenceIds),
        contradicting_evidence_ids_json: JSON.stringify(report.contradictingEvidenceIds),
        confidence: report.confidence,
        recommendation: report.recommendation,
        created_at: report.createdAt,
      });
    },

    getInvestigationReport(id: string): InvestigationReport | undefined {
      const row = getInvestigationReportStmt.get(id) as InvestigationReportRow | undefined;
      return row ? mapInvestigationReportRow(row) : undefined;
    },

    getInvestigationReportBySessionId(sessionId: string): InvestigationReport | undefined {
      const row = getInvestigationReportBySessionStmt.get(sessionId) as InvestigationReportRow | undefined;
      return row ? mapInvestigationReportRow(row) : undefined;
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────

    close(): void {
      db.close();
    },
  };

  const applyRecoveryTransaction = db.transaction((incidentId: string, recovery: OpsEvent): boolean => {
    const incident = store.getIncident(incidentId);
    if (!incident) return false;
    const linked = store.linkEventToIncident(incident.id, recovery.id);
    if (!linked && store.findIncidentByEventId(recovery.id)?.id !== incident.id) return false;
    store.updateIncident(incident.id, {
      first_seen: incident.first_seen,
      last_seen: laterTimestamp(incident.last_seen, recovery.time),
      event_count: incident.event_count + (linked ? 1 : 0),
      severity: incident.severity,
      state: 'RECOVERED',
    });
    store.removePendingRecovery(recovery.id);
    store.markEventProcessed(recovery.id, recovery.time);
    return true;
  });

  return store;
}