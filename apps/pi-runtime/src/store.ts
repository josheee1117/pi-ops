import Database from 'better-sqlite3';
import type { InvestigationRuntimeMetadata, InvestigationRuntimeResult } from '@pi-ops/protocol';

export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed';
export type DeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface RuntimeTaskRecord {
  runtimeRequestId: string;
  runtimeTaskId: string;
  sessionId: string;
  incidentId: string;
  executionStatus: ExecutionStatus;
  deliveryStatus: DeliveryStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  metadata?: InvestigationRuntimeMetadata;
  result?: InvestigationRuntimeResult;
  contextJson: string;
  deliveryAttempts: number;
}

interface RuntimeTaskRow {
  runtime_request_id: string;
  runtime_task_id: string;
  session_id: string;
  incident_id: string;
  execution_status: ExecutionStatus;
  delivery_status: DeliveryStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  metadata_json: string | null;
  result_json: string | null;
  context_json: string;
  delivery_attempts: number;
}

export function createRuntimeTaskStore(sqlitePath: string) {
  const db = new Database(sqlitePath);
  db.exec(`
CREATE TABLE IF NOT EXISTS runtime_tasks (
  runtime_request_id TEXT PRIMARY KEY,
  runtime_task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  metadata_json TEXT,
  result_json TEXT,
  context_json TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0
);
`);

  const insertStmt = db.prepare(`
INSERT INTO runtime_tasks (
  runtime_request_id, runtime_task_id, session_id, incident_id,
  execution_status, delivery_status, created_at, context_json, delivery_attempts
) VALUES (
  @runtime_request_id, @runtime_task_id, @session_id, @incident_id,
  @execution_status, @delivery_status, @created_at, @context_json, 0
);
`);
  const getStmt = db.prepare('SELECT * FROM runtime_tasks WHERE runtime_request_id = ?');
  const listPendingStmt = db.prepare(`
SELECT * FROM runtime_tasks
WHERE execution_status IN ('queued', 'running')
   OR (
     execution_status IN ('completed', 'failed')
     AND delivery_status IN ('pending', 'failed')
     AND delivery_attempts < @max_attempts
   )
ORDER BY created_at, runtime_request_id;
`);
  const updateStmt = db.prepare(`
UPDATE runtime_tasks SET
  execution_status = @execution_status,
  delivery_status = @delivery_status,
  started_at = @started_at,
  completed_at = @completed_at,
  last_error = @last_error,
  metadata_json = @metadata_json,
  result_json = @result_json,
  delivery_attempts = @delivery_attempts
WHERE runtime_request_id = @runtime_request_id;
`);

  return {
    getByRequestId(runtimeRequestId: string): RuntimeTaskRecord | undefined {
      const row = getStmt.get(runtimeRequestId) as RuntimeTaskRow | undefined;
      return row ? mapRow(row) : undefined;
    },

    create(input: {
      runtimeRequestId: string;
      sessionId: string;
      incidentId: string;
      contextJson: string;
      now: string;
    }): { task: RuntimeTaskRecord; duplicate: boolean } {
      const existing = this.getByRequestId(input.runtimeRequestId);
      if (existing) return { task: existing, duplicate: true };
      const runtimeTaskId = `rtask-${input.runtimeRequestId}`;
      insertStmt.run({
        runtime_request_id: input.runtimeRequestId,
        runtime_task_id: runtimeTaskId,
        session_id: input.sessionId,
        incident_id: input.incidentId,
        execution_status: 'queued',
        delivery_status: 'pending',
        created_at: input.now,
        context_json: input.contextJson,
      });
      return { task: this.getByRequestId(input.runtimeRequestId)!, duplicate: false };
    },

    update(runtimeRequestId: string, patch: Partial<RuntimeTaskRecord>): RuntimeTaskRecord {
      const current = this.getByRequestId(runtimeRequestId);
      if (!current) throw new Error(`unknown runtimeRequestId ${runtimeRequestId}`);
      const next: RuntimeTaskRecord = { ...current, ...patch, runtimeRequestId };
      updateStmt.run({
        runtime_request_id: runtimeRequestId,
        execution_status: next.executionStatus,
        delivery_status: next.deliveryStatus,
        started_at: next.startedAt ?? null,
        completed_at: next.completedAt ?? null,
        last_error: next.lastError ?? null,
        metadata_json: next.metadata ? JSON.stringify(next.metadata) : null,
        result_json: next.result ? JSON.stringify(next.result) : null,
        delivery_attempts: next.deliveryAttempts,
      });
      return this.getByRequestId(runtimeRequestId)!;
    },

    listResumable(maxAttempts: number): RuntimeTaskRecord[] {
      return (listPendingStmt.all({ max_attempts: maxAttempts }) as RuntimeTaskRow[]).map(mapRow);
    },

    close(): void {
      db.close();
    },
  };
}

export type RuntimeTaskStore = ReturnType<typeof createRuntimeTaskStore>;

function mapRow(row: RuntimeTaskRow): RuntimeTaskRecord {
  return {
    runtimeRequestId: row.runtime_request_id,
    runtimeTaskId: row.runtime_task_id,
    sessionId: row.session_id,
    incidentId: row.incident_id,
    executionStatus: row.execution_status,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as InvestigationRuntimeMetadata } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as InvestigationRuntimeResult } : {}),
    contextJson: row.context_json,
    deliveryAttempts: row.delivery_attempts,
  };
}
