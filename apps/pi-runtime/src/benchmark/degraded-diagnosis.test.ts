import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeInvestigationReportInput } from '@pi-ops/protocol';
import { MESSAGE_CASES } from './message-cases.js';
import { evaluateCase, evaluateMessage } from './evaluator.js';
import { renderMessageReport } from './report.js';
import { renderClosedLoopReport } from './closed-loop-report.js';
import type { CaseResult } from './runner.js';
import type { ClosedLoopCaseResult } from './closed-loop-runner.js';

const benchmarkCase = MESSAGE_CASES.find((item) => item.id === 'stack-overflow');
if (!benchmarkCase?.messageOracle) throw new Error('missing stack-overflow case');
const evidenceId = benchmarkCase.evidence[0]!.id;

const complete: RuntimeInvestigationReportInput = {
  hypothesis: '重复帧表明递归终止条件失效。',
  recommendation: '取得对应版本源码后修复递归。',
  confidence: 0.2,
  supportingEvidenceIds: [evidenceId],
  contradictingEvidenceIds: [],
  diagnosis: {
    summary: {
      scene: 'data-asset-service 调用栈溢出',
      whatHappened: '日志出现 StackOverflowError，影响未知。',
      severity: { level: '严重', reason: '服务可能不可用。' },
      recovery: ['隔离触发请求', '取得源码后修复递归', '验证健康与关键业务'],
    },
    observations: [{ statement: '栈顶重复出现 Recurse.down:7。', evidenceIds: [evidenceId] }],
    candidateCauses: [{ cause: '递归终止条件失效。', supportingEvidenceIds: [evidenceId], contradictingEvidenceIds: [] }],
    uncertainties: ['缺少部署版本源码。'],
    actions: [{
      purpose: 'verification', target: 'data-asset-service', preconditions: ['只读权限'],
      operation: '检查健康响应与关键业务请求。', expectedResult: '同一触发不再溢出。',
      risk: '只读。', requiresApproval: false, evidenceIds: [evidenceId],
    }],
  },
};

it('marks a diagnosis with the degraded prefix as not complete and not hard-passing', () => {
  const healthy = evaluateCase(benchmarkCase, { report: complete, findings: [] });
  assert.equal(healthy.checks.diagnosisComplete.status, 'pass');
  assert.equal(healthy.degraded, false);

  const degradedReport: RuntimeInvestigationReportInput = {
    ...complete,
    hypothesis: `诊断不完整。${complete.hypothesis}`,
    recommendation: `诊断不完整，以下仅供人工核对，修复尚未确定。${complete.recommendation}`,
  };
  const degraded = evaluateCase(benchmarkCase, { report: degradedReport, findings: [] });
  assert.equal(degraded.checks.diagnosisComplete.status, 'fail');
  assert.match(degraded.checks.diagnosisComplete.detail ?? '', /诊断不完整/);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.hardPass, false);

  const message = evaluateMessage(benchmarkCase.messageOracle!, degradedReport, [], benchmarkCase.evidence, '诊断更新\n修复尚未确定。');
  assert.equal(message.checks['diagnosisComplete']?.status, 'fail');
  assert.equal(message.degraded, true);
  assert.equal(message.hardPass, false);

  const caseResult = {
    caseId: 'stack-overflow', description: '', provider: 'fake', model: 'fake', mode: 'fake',
    thinking: { requested: 'off', effective: 'off', status: 'not_applicable' },
    status: 'completed', latencyMs: 0, tokenUsage: null, selectedSpecialists: [], specialistStatus: {},
    modelCalls: [], evidenceIds: [], evaluation: degraded, messageEvaluation: message,
    message: { content: '诊断更新\n修复尚未确定。', bytes: 30, fetchCalls: 1 },
    investigation: { findings: [] },
  } as unknown as CaseResult;
  assert.match(renderMessageReport([caseResult]), /未通过（诊断降级）/);

  const closedLoop = {
    caseId: 'stack-overflow', description: '', provenance: '', mode: 'fake', provider: 'fake', model: 'fake',
    diagnosis: { status: 'completed', provider: 'fake', model: 'fake', latencyMs: 0, tokens: 0, reportHardPass: false, messageHardPass: false, degraded: true },
    message: { content: '诊断更新', bytes: 12 }, detail: { bytes: 10, evidenceCount: 1, markdown: '详情' },
    sources: [], handler: { provider: 'fake', model: 'fake', status: 'answered', turns: 1, calls: [], inputTokens: 0, outputTokens: 0 },
    judge: { provider: 'fake', model: 'fake', items: [], notes: '', inputTokens: 0, outputTokens: 0 },
    verdict: 'open', failedItems: [], gaps: [], primaryGap: null, tokens: 0, latencyMs: 0,
  } as unknown as ClosedLoopCaseResult;
  const report = renderClosedLoopReport({
    results: [closedLoop], diagnosis: { provider: 'fake', model: 'fake', thinking: 'off' },
    handler: { provider: 'fake', model: 'fake' }, judge: { provider: 'fake', model: 'fake' },
    mode: 'fake', spent: 0, budget: 1, wallMs: 0,
  });
  assert.match(report, /completed（降级）/);
});
