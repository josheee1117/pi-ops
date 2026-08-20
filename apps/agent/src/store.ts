import Database from 'better-sqlite3';
import type { OpsEvent, EventBatch } from '@pi-ops/protocol';

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

// ── Store interface ──────────────────────────────────────────────────────────

export interface EventStore {
  /** Insert a validated batch. Returns the number of newly inserted rows. */
  insertBatch(batch: EventBatch, receiveTime: string): number;

  /** Total event count. */
  count(): number;

  // ── Incident operations ──────────────────────────────────────────────────

  /** Find the most recent OPEN incident with the given fingerprint. */
  findOpenIncident(fingerprint: string): IncidentRow | undefined;

  /** Create a new incident. */
  createIncident(incident: Omit<IncidentRow, 'id'>): IncidentRow;

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

  const insertStmt = db.prepare(INSERT_EVENT_SQL);
  const countStmt = db.prepare(COUNT_EVENTS_SQL);
  const findOpenIncidentStmt = db.prepare(FIND_OPEN_INCIDENT_SQL);
  const insertIncidentStmt = db.prepare(INSERT_INCIDENT_SQL);
  const updateIncidentStmt = db.prepare(UPDATE_INCIDENT_SQL);
  const linkEventStmt = db.prepare(LINK_EVENT_SQL);
  const countIncidentsStmt = db.prepare(COUNT_INCIDENTS_SQL);

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

    createIncident(incident: Omit<IncidentRow, 'id'>): IncidentRow {
      const id = generateId('inc');
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
      return { id, ...incident };
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

    // ── Lifecycle ─────────────────────────────────────────────────────────

    close(): void {
      db.close();
    },
  };
}