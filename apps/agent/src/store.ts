import Database from 'better-sqlite3';
import type { OpsEvent, EventBatch, Evidence } from '@pi-ops/protocol';

// ── Event types ──────────────────────────────────────────────────────────────

export interface StoredEvent {
  id: string;
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

export interface EvidenceRecord extends Evidence {
  status: EvidenceStatus;
  error?: string;
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

// ── SQL ──────────────────────────────────────────────────────────────────────

const CREATE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
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
  error TEXT
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

const INSERT_EVENT_SQL = `
INSERT OR IGNORE INTO events (
  id, receive_time, producer_id, producer_type, producer_version,
  source, node_id, service, type, severity,
  fingerprint, trace_id, message, attributes
) VALUES (
  @id, @receive_time, @producer_id, @producer_type, @producer_version,
  @source, @node_id, @service, @type, @severity,
  @fingerprint, @trace_id, @message, @attributes
);
`;

const COUNT_EVENTS_SQL = `SELECT COUNT(*) as count FROM events`;

const FIND_OPEN_INCIDENT_SQL = `
SELECT * FROM incidents
WHERE fingerprint = @fingerprint AND state = 'OPEN'
ORDER BY last_seen DESC
LIMIT 1;
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
SET last_seen = @last_seen,
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
  id, incident_id, node_id, source, kind, collected_at, status, data_json, error
) VALUES (
  @id, @incident_id, @node_id, @source, @kind, @collected_at, @status, @data_json, @error
)
ON CONFLICT(id) DO UPDATE SET
  incident_id = excluded.incident_id,
  node_id = excluded.node_id,
  source = excluded.source,
  kind = excluded.kind,
  collected_at = excluded.collected_at,
  status = excluded.status,
  data_json = excluded.data_json,
  error = excluded.error;
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

// ── Store interface ──────────────────────────────────────────────────────────

export interface EventStore {
  /** Insert a validated batch. Returns the number of newly inserted rows. */
  insertBatch(batch: EventBatch, receiveTime: string): number;

  /** Total event count. */
  count(): number;

  // ── Incident operations ──────────────────────────────────────────────────

  /** Find the most recent OPEN incident with the given fingerprint. */
  findOpenIncident(fingerprint: string): IncidentRow | undefined;

  /** Find the Incident already linked to an immutable Event fact. */
  findIncidentByEventId(eventId: string): IncidentRow | undefined;

  /** Create a new incident without scheduling evidence (tests/manual use). */
  createIncident(incident: Omit<IncidentRow, 'id'>): IncidentRow;

  /** Atomically create Incident + event link + durable evidence job. */
  createIncidentFromEvent(
    incident: Omit<IncidentRow, 'id'>,
    event: OpsEvent,
  ): IncidentRow;

  /** Update an existing incident's mutable fields. */
  updateIncident(id: string, updates: {
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

  /** Close the database connection. */
  close(): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

let idCounter = 0;

function generateId(prefix: string): string {
  idCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}-${idCounter}`;
}

export function createEventStore(dbPath: string): EventStore {
  const db = new Database(dbPath);

  // Performance + safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(CREATE_EVENTS_TABLE_SQL);
  db.exec(CREATE_INCIDENTS_TABLE_SQL);
  db.exec(CREATE_INCIDENT_EVENTS_TABLE_SQL);
  db.exec(CREATE_EVIDENCE_TABLE_SQL);
  db.exec(CREATE_EVIDENCE_JOBS_TABLE_SQL);

  const insertStmt = db.prepare(INSERT_EVENT_SQL);
  const countStmt = db.prepare(COUNT_EVENTS_SQL);
  const findOpenIncidentStmt = db.prepare(FIND_OPEN_INCIDENT_SQL);
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

  const createIncidentFromEventTransaction = db.transaction((
    incident: Omit<IncidentRow, 'id'>,
    event: OpsEvent,
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
    return { id, ...incident };
  });

  return {
    // ── Events ────────────────────────────────────────────────────────────

    insertBatch(batch: EventBatch, receiveTime: string): number {
      let inserted = 0;

      const insertMany = db.transaction((events: OpsEvent[]) => {
        for (const event of events) {
          const result = insertStmt.run({
            id: event.id,
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
          if (result.changes > 0) {
            inserted++;
          }
        }
      });

      insertMany(batch.events);
      return inserted;
    },

    count(): number {
      const row = countStmt.get() as { count: number };
      return row.count;
    },

    // ── Incidents ─────────────────────────────────────────────────────────

    findOpenIncident(fingerprint: string): IncidentRow | undefined {
      return findOpenIncidentStmt.get({ fingerprint }) as IncidentRow | undefined;
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
    ): IncidentRow {
      return createIncidentFromEventTransaction(incident, event);
    },

    updateIncident(id: string, updates: {
      last_seen: string;
      event_count: number;
      severity: string;
      state: IncidentState;
    }): void {
      updateIncidentStmt.run({
        id,
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

    // ── Lifecycle ─────────────────────────────────────────────────────────

    close(): void {
      db.close();
    },
  };
}