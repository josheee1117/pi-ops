import Database from 'better-sqlite3';
import type { OpsEvent, EventBatch } from '@pi-ops/protocol';

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

const CREATE_TABLE_SQL = `
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

export interface EventStore {
  /** Insert a validated batch. Returns the number of newly inserted rows. */
  insertBatch(batch: EventBatch, receiveTime: string): number;
  /** Total event count (for tests). */
  count(): number;
  /** Close the database connection. */
  close(): void;
}

export function createEventStore(dbPath: string): EventStore {
  const db = new Database(dbPath);

  // Performance + safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(CREATE_TABLE_SQL);

  const insertStmt = db.prepare(INSERT_EVENT_SQL);
  const countStmt = db.prepare(COUNT_EVENTS_SQL);

  return {
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

    close(): void {
      db.close();
    },
  };
}