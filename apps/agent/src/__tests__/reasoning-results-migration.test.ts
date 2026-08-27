import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createEventStore } from '../store.js';

const LEGACY_REASONING_RESULTS_SQL = `
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
`;

describe('reasoning_results one-job invariant', () => {
  it('fails clearly when legacy rows share a reasoning_job_id', () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'pi-ops-rr-')), 'dup.sqlite');
    const legacy = new Database(sqlitePath);
    legacy.exec(LEGACY_REASONING_RESULTS_SQL);
    const insert = legacy.prepare(`
INSERT INTO reasoning_results (
  id, incident_id, created_at, hypotheses_json, missing_evidence_json, confidence, status, reasoning_job_id
) VALUES (?, ?, ?, '[]', '[]', 0.5, 'complete', ?);
`);
    insert.run('reason-a', 'inc-1', '2026-08-20T12:00:00.000Z', 'rj-shared');
    insert.run('reason-b', 'inc-1', '2026-08-20T12:01:00.000Z', 'rj-shared');
    legacy.close();
    assert.throws(
      () => createEventStore(sqlitePath),
      /duplicate reasoning_job_id \(rj-shared\)/,
    );
  });

  it('keeps one result per job after migration', () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'pi-ops-rr-')), 'ok.sqlite');
    const legacy = new Database(sqlitePath);
    legacy.exec(LEGACY_REASONING_RESULTS_SQL);
    legacy.prepare(`
INSERT INTO reasoning_results (
  id, incident_id, created_at, hypotheses_json, missing_evidence_json, confidence, status, reasoning_job_id
) VALUES (?, ?, ?, '[]', '[]', 0.5, 'complete', ?);
`).run('reason-a', 'inc-1', '2026-08-20T12:00:00.000Z', 'rj-1');
    legacy.close();
    const store = createEventStore(sqlitePath);
    assert.equal(store.getReasoningResultByJobId('rj-1')?.id, 'reason-a');
    store.close();
  });
});
