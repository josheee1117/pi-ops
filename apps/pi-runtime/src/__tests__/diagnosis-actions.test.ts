import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { investigationReportInputSchema, type RuntimeInvestigationContext } from '@pi-ops/protocol';
import { investigate } from '../coordinator.js';
import type { RuntimeModel } from '../model.js';

const context: RuntimeInvestigationContext = {
  schemaVersion: 1,
  incident: { id: 'inc-actions', type: 'application.error', service: 'orders' },
  evidence: [{
    id: 'ev-config', kind: 'docker.logs',
    data: { lines: ['effective route=/old; deployed contract route=/orders; response=404'] },
  }],
};

const repair = {
  purpose: 'repair', target: 'orders 客户端路由',
  preconditions: ['当前部署契约仍为 /orders，且生效路由仍为 /old。'],
  operation: '将客户端路由从已核实的 /old 改为 /orders，按发布流程保留旧配置供回滚。',
  expectedResult: '受控请求命中 /orders，不再返回路由 404。',
  risk: '配置发布可能影响现有调用，失败时回滚旧路由。',
  requiresApproval: true, evidenceIds: ['ev-config'],
};

function diagnosis(action = repair) {
  return {
    observations: [{ statement: '生效路由与部署契约不同。', evidenceIds: ['ev-config'] }],
    candidateCauses: [{
      cause: '客户端路由未同步。', supportingEvidenceIds: ['ev-config'], contradictingEvidenceIds: [],
    }],
    uncertainties: ['尚未验证当前全部调用方。'],
    actions: [action],
  };
}

function scriptedModel(detail: ReturnType<typeof diagnosis>, systems: string[] = []): RuntimeModel {
  return {
    provider: 'scripted-test', model: 'no-network', networkCalls: 0,
    async invoke(request) {
      systems.push(request.system);
      const common = {
        supportingEvidenceIds: ['ev-config'], contradictingEvidenceIds: [], confidence: 0.8,
        diagnosis: detail,
      };
      return { text: JSON.stringify(request.system.includes('COORDINATOR_SYNTHESIS') ? {
        ...common, hypothesis: '路由不一致。', recommendation: '先核对生效配置，再按条件修复。' + '保留完整依据。'.repeat(260) + '末尾验证不可丢失。',
      } : {
        ...common, role: 'application_business', hypotheses: ['路由不一致。'],
        missingEvidence: [], summary: '已看到配置与契约差异，需复核当前版本。', status: 'completed',
      }) };
    },
  };
}

describe('diagnosis and action contract', () => {
  it('preserves an evidenced conditional repair and full diagnosis without phone limits or policy prefixes', async () => {
    const systems: string[] = [];
    const model = scriptedModel(diagnosis(), systems);
    const outcome = await investigate(context, { model });
    assert.equal(outcome.status, 'completed', outcome.error);
    assert.deepEqual(outcome.report?.diagnosis, diagnosis());
    assert.deepEqual(outcome.findings[0]?.diagnosis, diagnosis());
    assert.equal(outcome.report?.recommendation, '先核对生效配置，再按条件修复。' + '保留完整依据。'.repeat(260) + '末尾验证不可丢失。');
    assert.equal(investigationReportInputSchema.safeParse(outcome.report).success, true);
    for (const system of systems) {
      assert.doesNotMatch(system, /320 个字符|180 个字符|不是调查底稿/);
      assert.match(system, /没有已核实.*配置值/);
      assert.match(system, /Do not persist chain-of-thought/);
    }
    assert.equal(model.networkCalls, 0);
  });

  it('keeps insufficient evidence honest with a concrete distinguishing check and branches', async () => {
    const check = {
      purpose: 'evidence_collection', target: 'orders 路由及部署版本',
      preconditions: ['当前只有 404，生效配置与对应版本契约尚未提供。'],
      operation: '人工读取当前生效路由和同部署版本接口契约并对照。若路由不同，提交差异供确认后修正；若一致，检查该请求是否到达目标实例。不要猜测新路由值。',
      expectedResult: '区分客户端路由错误和请求到达错误实例，记录实际值后再确定修法。',
      risk: '只读检查，不修改配置。', requiresApproval: false, evidenceIds: ['ev-config'],
    };
    const detail = {
      ...diagnosis(check), observations: [{ statement: '当前请求返回 404。', evidenceIds: ['ev-config'] }],
      candidateCauses: [
        { cause: '路由不一致。', supportingEvidenceIds: ['ev-config'], contradictingEvidenceIds: [] },
        { cause: '请求到达错误实例。', supportingEvidenceIds: [], contradictingEvidenceIds: [] },
      ],
      uncertainties: ['缺少生效配置与对应版本契约，修复尚未确定。'],
    };
    const outcome = await investigate({ ...context, evidence: [{ id: 'ev-config', kind: 'docker.logs', data: { lines: ['404'] } }] }, { model: scriptedModel(detail) });
    assert.equal(outcome.status, 'completed', outcome.error);
    assert.deepEqual(outcome.report?.diagnosis, detail);
    assert.equal(outcome.report?.diagnosis?.actions.some((action) => action.purpose === 'repair'), false);
  });

  it('rejects foreign references in specialist and coordinator actions or diagnostic conclusions', async () => {
    for (const layer of ['specialist', 'coordinator']) {
      for (const field of ['actions', 'observations', 'candidateCauses']) {
        const base = scriptedModel(diagnosis());
        const model: RuntimeModel = {
          ...base,
          async invoke(request) {
            const response = await base.invoke(request);
            if ((layer === 'coordinator') === request.system.includes('COORDINATOR_SYNTHESIS')) {
              const payload = JSON.parse(response.text);
              const item = payload.diagnosis[field][0];
              if (field === 'candidateCauses') item.contradictingEvidenceIds = ['ev-foreign'];
              else item.evidenceIds = ['ev-foreign'];
              return { text: JSON.stringify(payload) };
            }
            return response;
          },
        };
        const outcome = await investigate(context, { model });
        assert.equal(outcome.status, 'failed', `${layer} ${field}`);
        assert.equal(outcome.report, undefined);
      }
    }
  });

  it('degrades missing diagnosis at both live boundaries while accepting legacy report input', async () => {
    for (const layer of ['specialist', 'coordinator']) {
      const base = scriptedModel(diagnosis());
      const model: RuntimeModel = {
        ...base,
        async invoke(request) {
          const response = await base.invoke(request);
          if ((layer === 'coordinator') === request.system.includes('COORDINATOR_SYNTHESIS')) {
            const payload = JSON.parse(response.text);
            delete payload.diagnosis;
            return { text: JSON.stringify(payload) };
          }
          return response;
        },
      };
      const outcome = await investigate(context, { model });
      assert.equal(outcome.status, 'completed', layer);
      assert.equal(outcome.report?.diagnosis, undefined);
      assert.match(outcome.report?.hypothesis ?? '', /诊断不完整/);
    }
    assert.equal(investigationReportInputSchema.safeParse({
      hypothesis: '旧报告', supportingEvidenceIds: [], contradictingEvidenceIds: [],
      confidence: 0.5, recommendation: '补证。',
    }).success, true);
  });

  it('rejects incomplete, unbounded, or unsupported actions through the protocol schema', () => {
    const report = {
      hypothesis: '路由不一致。', supportingEvidenceIds: ['ev-config'], contradictingEvidenceIds: [],
      confidence: 0.8, recommendation: '复核路由。', diagnosis: diagnosis(),
    };
    for (const action of [
      { ...repair, target: '' }, { ...repair, preconditions: [] },
      { ...repair, operation: '' }, { ...repair, expectedResult: '' },
      { ...repair, risk: '' }, { ...repair, requiresApproval: undefined },
      { ...repair, purpose: 'execute' }, { ...repair, evidenceIds: [] },
    ]) {
      assert.equal(investigationReportInputSchema.safeParse({ ...report, diagnosis: { ...diagnosis(), actions: [action] } }).success, false);
    }
    assert.equal(investigationReportInputSchema.safeParse({ ...report, diagnosis: { ...diagnosis(), actions: Array(9).fill(repair) } }).success, false);
    assert.equal(investigationReportInputSchema.safeParse({ ...report, diagnosis: { ...diagnosis(), actions: [] } }).success, false);
  });
});
