import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createEventStore } from '../store.js';

const LEGACY_REASONING_JOBS_SQL = `
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

describe('reasoning_jobs legacy schema migration', () => {
  it('keeps legacy rows and allows several jobs per Incident', () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'pi-ops-legacy-')), 'legacy.sqlite');
    const legacy = new Database(sqlitePath);
    legacy.exec(LEGACY_REASONING_JOBS_SQL);
    legacy.prepare(`
INSERT INTO reasoning_jobs (
  id, incident_id, reasoner_type, reasoner_version, status, attempts, last_error, created_at, updated_at
) VALUES (
  @id, @incident_id, @reasoner_type, @reasoner_version, @status, @attempts, @last_error, @created_at, @updated_at
);
`).run({
      id: 'rj-legacy-1',
      incident_id: 'inc-legacy',
      reasoner_type: 'fake',
      reasoner_version: '1',
      status: 'COMPLETED',
      attempts: 2,
      last_error: 'earlier transient failure',
      created_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:05:00.000Z',
    });
    const legacySchema = legacy.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reasoning_jobs'",
    ).get() as { sql: string };
    assert.ok(legacySchema.sql.includes('incident_id TEXT NOT NULL UNIQUE'));
    legacy.close();

    const store = createEventStore(sqlitePath);
    const migrated = store.getReasoningJob('rj-legacy-1');
    assert.ok(migrated);
    assert.equal(migrated.incidentId, 'inc-legacy');
    assert.equal(migrated.reasonerType, 'fake');
    assert.equal(migrated.reasonerVersion, '1');
    assert.equal(migrated.status, 'COMPLETED');
    assert.equal(migrated.attempts, 2);
    assert.equal(migrated.lastError, 'earlier transient failure');
    assert.equal(migrated.createdAt, '2026-08-01T10:00:00.000Z');
    assert.equal(migrated.updatedAt, '2026-08-01T10:05:00.000Z');

    store.createReasoningJob({
      id: 'rj-inv-attempt-a',
      incidentId: 'inc-legacy',
      reasonerType: 'delegated_analysis',
      reasonerVersion: '1',
      createdAt: '2026-08-02T10:00:00.000Z',
    });
    store.createReasoningJob({
      id: 'rj-inv-attempt-b',
      incidentId: 'inc-legacy',
      reasonerType: 'delegated_analysis',
      reasonerVersion: '1',
      createdAt: '2026-08-02T11:00:00.000Z',
    });
    assert.ok(store.getReasoningJob('rj-inv-attempt-a'));
    assert.ok(store.getReasoningJob('rj-inv-attempt-b'));
    assert.ok(store.getReasoningJob('rj-legacy-1'));
    store.close();

    const inspect = new Database(sqlitePath);
    const schema = inspect.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reasoning_jobs'",
    ).get() as { sql: string };
    assert.equal(schema.sql.includes('UNIQUE'), false);
    const indexes = (inspect.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reasoning_jobs'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(indexes.includes('idx_reasoning_jobs_status'));
    assert.ok(indexes.includes('idx_reasoning_jobs_incident'));
    const count = inspect.prepare('SELECT COUNT(*) as count FROM reasoning_jobs').get() as { count: number };
    assert.equal(count.count, 3);
    inspect.close();
  });
});
