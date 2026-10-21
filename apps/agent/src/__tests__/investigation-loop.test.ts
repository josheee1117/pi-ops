import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { investigationReportInputSchema } from '@pi-ops/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { createIncidentEngine } from '../incident.js';
import { makeAgentConfig } from './test-config.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createInvestigationQualityService } from '../investigation-quality.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedIncident(store = createEventStore(':memory:'), evidenceOverrides: Partial<EvidenceRecord> = {}) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-inv-loop',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord = {
    id: 'evd-inv-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
    ...evidenceOverrides,
  };
  store.insertEvidence(evidence);
  return { store, incident, evidence };
}

function reportInput(overrides: Partial<Parameters<ReturnType<typeof createInvestigationLoopService>['complete']>[1]> = {}) {
  return {
    hypothesis: 'database side investigation required',
    supportingEvidenceIds: ['evd-inv-1'],
    contradictingEvidenceIds: [],
    confidence: 0.74,
    recommendation: 'inspect SQL and indexes',
    ...overrides,
  };
}

const actionDiagnosis = {
  observations: [{ statement: '故障期负载偏低。', evidenceIds: ['evd-inv-1'] }],
  candidateCauses: [{ cause: 'SQL 计划可能不匹配。', supportingEvidenceIds: [], contradictingEvidenceIds: ['evd-inv-1'] }],
  uncertainties: ['尚未采到慢 SQL 和索引定义，不能确定修复值。'],
  actions: [{
    purpose: 'evidence_collection' as const, target: 'data-asset-service 慢 SQL',
    preconditions: ['由有查询权限的值班人员执行只读检查。'],
    operation: '读取故障时间窗慢 SQL 及执行计划。若全表扫描则核对索引，若锁等待则核对阻塞事务。',
    expectedResult: '区分索引问题与事务阻塞，记录实际计划后再确定修法。',
    risk: '执行计划检查可能消耗数据库资源，不运行写操作。', requiresApproval: true,
    evidenceIds: ['evd-inv-1'],
  }],
};

describe('InvestigationLoopService', () => {
  it('validates scripted model repairs, evidence gaps and foreign references before durable storage', async () => {
    const runtimeDir = ['..', '..', '..', 'pi-runtime', 'src'].join('/');
    const { investigate } = await import(`${runtimeDir}/coordinator.js`);
    for (const scenario of ['repair', 'insufficient', 'foreign']) {
      const { store, incident } = seedIncident(createEventStore(':memory:'), scenario === 'insufficient' ? {} : {
        source: 'docker', kind: 'docker.logs',
        data: { lines: ['effective route=/old; deployed contract route=/orders; response=404'] },
      });
      try {
        const loop = createInvestigationLoopService(store);
        const { session, context } = loop.start(incident.id);
        await loop.submit(session.id);
        const action = scenario === 'insufficient' ? actionDiagnosis.actions[0]! : {
          purpose: 'repair', target: 'data-asset-service 客户端路由',
          preconditions: ['复核生效路由仍为 /old，且当前部署契约仍为 /orders。'],
          operation: '经批准将路由从 /old 改为 /orders；失败时回滚 /old。',
          expectedResult: '受控请求命中 /orders，不再返回路由 404。',
          risk: '发布可能影响现有调用。', requiresApproval: true, evidenceIds: ['evd-inv-1'],
        };
        const diagnosis = {
          ...(scenario === 'insufficient' ? actionDiagnosis : {
            observations: [{ statement: '生效路由 /old 与部署契约 /orders 不同。', evidenceIds: ['evd-inv-1'] }],
            candidateCauses: [{ cause: '客户端路由未同步。', supportingEvidenceIds: ['evd-inv-1'], contradictingEvidenceIds: [] }],
            uncertainties: ['尚未验证全部调用方。'],
          }),
          actions: [{ ...action, evidenceIds: [scenario === 'foreign' ? 'missing-id' : 'evd-inv-1'] }],
        };
        const model = {
          provider: 'scripted-test', model: 'no-network', networkCalls: 0,
          async invoke(request: { system: string }) {
            return { text: JSON.stringify(request.system.includes('COORDINATOR_SYNTHESIS')
              ? { ...reportInput(), diagnosis }
              : { role: 'application_business', hypotheses: ['修复仍需前提确认。'],
                supportingEvidenceIds: ['evd-inv-1'], contradictingEvidenceIds: [], confidence: 0.8,
                missingEvidence: [], summary: '当前证据诊断。', status: 'completed', diagnosis }) };
          },
        };
        const runtimeContext = {
          ...context, incident: { ...context.incident, type: 'application.error' },
        };
        const outcome = await investigate(runtimeContext, { model });
        if (scenario === 'foreign') {
          assert.equal(outcome.status, 'failed');
          assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
        } else {
          assert.equal(outcome.status, 'completed', outcome.error);
          const report = loop.complete(session.id, investigationReportInputSchema.parse(outcome.report));
          assert.deepEqual(store.getInvestigationReport(report.id)?.diagnosis?.actions, diagnosis.actions);
        }
        assert.equal(model.networkCalls, 0);
      } finally { store.close(); }
    }
  });

  it('stores and reads diagnosis without notifying an unalerted legacy incident', async () => {
    const { store, incident } = seedIncident();
    try {
      const loop = createInvestigationLoopService(store);
      const { session } = loop.start(incident.id);
      await loop.submit(session.id);
      const report = loop.complete(session.id, reportInput({ diagnosis: actionDiagnosis }));
      assert.deepEqual(report.diagnosis, actionDiagnosis);
      assert.deepEqual(store.getInvestigationReport(report.id)?.diagnosis, actionDiagnosis);
      assert.deepEqual(store.getInvestigationReportBySessionId(session.id)?.diagnosis, actionDiagnosis);
      assert.deepEqual(store.listAllInvestigationReports()[0]?.diagnosis, actionDiagnosis);
      const notification = store.listNotificationJobs(incident.id).find((job) => job.type === 'INVESTIGATION_COMPLETED');
      assert.equal(notification, undefined);
      const config = makeAgentConfig();
      const app = createApp(config, store, createIncidentEngine(store, config));
      const response = await app.request(`/v1/ops/incidents/${incident.id}`, {
        headers: { Authorization: 'Bearer operator-token' },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.sessions[0].report.diagnosis, actionDiagnosis);
    } finally { store.close(); }
  });

  it('rejects invalid action fields and foreign references without storing a report or scheduling completion', async () => {
    for (const diagnosis of [
      { ...actionDiagnosis, actions: [{ ...actionDiagnosis.actions[0]!, target: '' }] },
      { ...actionDiagnosis, actions: [{ ...actionDiagnosis.actions[0]!, evidenceIds: ['evd-other'] }] },
      { ...actionDiagnosis, observations: [{ statement: '不存在的观测', evidenceIds: ['evd-other'] }] },
      { ...actionDiagnosis, candidateCauses: [{ cause: '不存在的反证', supportingEvidenceIds: [], contradictingEvidenceIds: ['evd-other'] }] },
    ]) {
      const { store, incident } = seedIncident();
      try {
        const loop = createInvestigationLoopService(store);
        const { session } = loop.start(incident.id);
        await loop.submit(session.id);
        assert.throws(() => loop.complete(session.id, reportInput({ diagnosis })), /actions|does not belong/);
        assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
        assert.equal(store.listNotificationJobs(incident.id).some((job) => job.type === 'INVESTIGATION_COMPLETED'), false);
        assert.equal(store.getInvestigationSession(session.id)?.status, 'SUBMITTED');
      } finally { store.close(); }
    }
  });

  it('migrates an existing database additively and preserves reports across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diagnosis-contract-'));
    const path = join(dir, 'agent.sqlite');
    let store = createEventStore(path);
    try {
      const { incident } = seedIncident(store);
      const loop = createInvestigationLoopService(store);
      const { session } = loop.start(incident.id);
      await loop.submit(session.id);
      const legacy = loop.complete(session.id, reportInput());
      store.insertBatch({
        producer: { id: 'test-producer', type: 'application', version: '1' },
        events: [{
          schemaVersion: 1, id: 'evt-migration', time: incident.first_seen,
          source: 'application', nodeId: incident.node_id, service: incident.service,
          type: incident.type, severity: 'warning', message: 'slow SQL', attributes: {},
        }],
      }, incident.first_seen);
      store.linkEventToIncident(incident.id, 'evt-migration');
      store.close();
      const db = new Database(path);
      db.exec('ALTER TABLE investigation_reports DROP COLUMN diagnosis_json');
      db.close();
      store = createEventStore(path);
      assert.deepEqual(store.getInvestigationReport(legacy.id), legacy);
      const reopenedLoop = createInvestigationLoopService(store);
      const next = reopenedLoop.start(incident.id);
      await reopenedLoop.submit(next.session.id);
      const structured = reopenedLoop.complete(next.session.id, reportInput({ diagnosis: actionDiagnosis }));
      store.close();
      store = createEventStore(path);
      assert.deepEqual(store.getInvestigationReport(structured.id), structured);
      assert.deepEqual(store.getInvestigationReport(legacy.id), legacy);
      assert.deepEqual(store.listAllInvestigationReports().find((report) => report.id === structured.id)?.diagnosis, actionDiagnosis);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads legacy reports without inventing a diagnosis', async () => {
    const { store, incident } = seedIncident();
    try {
      const loop = createInvestigationLoopService(store);
      const { session } = loop.start(incident.id);
      await loop.submit(session.id);
      const report = loop.complete(session.id, reportInput());
      assert.deepEqual(store.getInvestigationReport(report.id), report);
      assert.equal('diagnosis' in store.getInvestigationReport(report.id)!, false);
    } finally { store.close(); }
  });
  it('walks the session lifecycle CREATED → SUBMITTED → RUNNING → COMPLETED', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store, {
      now: () => '2026-08-21T06:00:00.000Z',
    });
    const started = loop.start(incident.id);
    assert.equal(started.session.status, 'CREATED');
    assert.equal(started.session.incidentId, incident.id);
    assert.ok(started.session.delegationTaskId);
    const submitted = await loop.submit(started.session.id);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(store.getDelegationTask(submitted.delegationTaskId)?.status, 'SUBMITTED');
    const running = loop.markRunning(started.session.id);
    assert.equal(running.status, 'RUNNING');
    const report = loop.complete(started.session.id, reportInput());
    const completed = store.getInvestigationSession(started.session.id)!;
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.completedAt, '2026-08-21T06:00:00.000Z');
    assert.equal(report.sessionId, started.session.id);
    assert.equal(report.hypothesis, 'database side investigation required');
    assert.equal(store.getInvestigationReportBySessionId(started.session.id)?.id, report.id);
    store.close();
  });

  it('keeps the InvestigationContext snapshot immutable', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session, context } = loop.start(incident.id);
    const stored = store.getInvestigationContextSnapshot(session.contextSnapshotHash)!;
    assert.equal(stored.incident.id, context.incident.id);
    assert.ok(Object.isFrozen(stored));
    assert.throws(() => {
      (stored as { incident: { id: string } }).incident.id = 'mutated';
    });
    const again = loop.start(incident.id);
    assert.equal(again.session.contextSnapshotHash, session.contextSnapshotHash);
    assert.deepEqual(
      store.getInvestigationContextSnapshot(again.session.contextSnapshotHash),
      stored,
    );
    store.close();
  });

  it('rejects an invalid report without writing it', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    assert.throws(
      () => loop.complete(session.id, reportInput({ confidence: 1.4 })),
      /confidence/,
    );
    assert.equal(store.getInvestigationSession(session.id)?.status, 'SUBMITTED');
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    assert.equal(store.listReasoningResults(incident.id).length, 0);
    store.close();
  });

  it('rejects evidence ids that do not belong to the Incident', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    assert.throws(
      () => loop.complete(session.id, reportInput({
        supportingEvidenceIds: ['evd-other'],
      })),
      /does not belong/,
    );
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('does not modify Incident or Evidence when the runtime fails', async () => {
    const { store, incident, evidence } = seedIncident();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    const failed = loop.fail(session.id, 'runtime crashed');
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.equal(store.listEvidence(incident.id)[0]?.id, evidence.id);
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('requires InvestigationReport and Evaluation before a MemoryCandidate', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    const report = loop.complete(session.id, reportInput());
    assert.equal(store.listMemoryCandidates().length, 0);
    createInvestigationQualityService(store).evaluate(report.id);
    const result = store.listReasoningResults(incident.id)[0]!;
    assert.equal(result.investigationReportId, report.id);
    const { candidate, evaluation } = createReasoningEvaluationService(store).evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed after runtime report',
    });
    assert.ok(evaluation);
    assert.ok(candidate);
    assert.equal(candidate.sourceReasoningResultId, result.id);
    store.close();
  });
});
