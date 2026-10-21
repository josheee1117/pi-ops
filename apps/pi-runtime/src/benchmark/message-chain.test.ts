import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_CASES } from './message-cases.js';
import { projectCase, fixedEvidenceClient } from './agent-chain.js';
import { runCase, runBenchmark } from './runner.js';
import { createFakeRuntimeModel } from '../model.js';
import { evaluateMessage } from './evaluator.js';
import { renderMessageReport } from './report.js';
import type { RuntimeEvidenceResponse, RuntimeInvestigationReportInput } from '@pi-ops/protocol';

it('keeps the actual 197-line fault and accurate clipping metadata through the agent projection', async () => {
  const sample = MESSAGE_CASES[0]!;
  const raw = sample.evidence.find((item) => item.kind === 'docker.logs')!;
  const data = raw.data as { lines: string[] };
  assert.equal(data.lines.length, 197);
  assert.match(data.lines[132]!, /Real DataAsset lab fault injection/);
  const context = await projectCase(sample);
  assert.match(JSON.stringify(context), /Real DataAsset lab fault injection/);
  assert.match(JSON.stringify(context), /originalLineCount.*197/);
  assert.ok(context.evidence.every((item) => JSON.stringify(item).length > 0));
  assert.ok('truncation' in context);
  for (const item of MESSAGE_CASES) {
    assert.ok(item.messageOracle?.expectedFacts.length);
    assert.ok(item.messageOracle?.allowedRepairs.length);
    assert.ok(item.messageOracle?.forbiddenAttributions.length);
    await projectCase(item);
  }
});

it('returns only requested recorded supplements through the same agent projection', async () => {
  const sample = MESSAGE_CASES[1]!;
  const responses: RuntimeEvidenceResponse[] = [];
  const response = await fixedEvidenceClient(sample, responses).request({
    runtimeRequestId: 'r', runtimeTaskId: 't', sessionId: 's',
    requests: [
      { requestId: 'logs', type: 'docker.logs', requestingRoles: ['jvm'] },
      { requestId: 'probe', type: 'http.probe', requestingRoles: ['jvm'] },
    ],
  });
  assert.equal(response.results[0]!.status, 'collected');
  assert.equal(response.results[1]!.status, 'unavailable');
  assert.equal(responses.length, 1);
});

function report(): RuntimeInvestigationReportInput {
  const id = MESSAGE_CASES[3]!.evidence[0]!.id;
  const action = {
    target: 'POST /api/v1/tag/admin/tag-group/page', preconditions: ['确认同一故障仍影响请求'],
    operation: '核对第106行与完整 cause 后按实际分支处理。', expectedResult: '相同请求不再返回业务502。',
    risk: '不要重复写入。', requiresApproval: true, evidenceIds: [id],
  };
  return {
    hypothesis: '第106行抛出异常，触发逻辑未知。', recommendation: '核对对应版本源码。',
    confidence: 0.6, supportingEvidenceIds: [id], contradictingEvidenceIds: [],
    diagnosis: {
      observations: [{ statement: 'RuntimeException', evidenceIds: [id] }],
      candidateCauses: [{ cause: '触发逻辑未知', supportingEvidenceIds: [id], contradictingEvidenceIds: [] }],
      uncertainties: ['修复尚未确定'], actions: [
        { ...action, purpose: 'mitigation', operation: '影响持续时经批准隔离已确认的故障请求。' },
        { ...action, purpose: 'repair' },
        { ...action, purpose: 'verification', operation: '人工受控复现相同请求并检查返回码。' },
      ],
    },
  };
}

it('runs the real notifier with fake fetch and checks action visibility, bytes, and all diagnosis citations', async () => {
  const sample = MESSAGE_CASES[3]!;
  const output = report();
  const result = await runCase(sample, {
    model: { ...createFakeRuntimeModel({
      synthesisText: JSON.stringify(output),
      specialistText: { application_business: JSON.stringify({
        role: 'application_business', hypotheses: [output.hypothesis],
        supportingEvidenceIds: output.supportingEvidenceIds, contradictingEvidenceIds: [],
        missingEvidence: [], confidence: 0.6, summary: output.hypothesis,
        diagnosis: output.diagnosis, status: 'completed',
      }) },
    }), provider: 'scripted' }, mode: 'fake', thinkingLevel: 'off',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.message?.fetchCalls, 1);
  assert.equal(result.messageEvaluation?.hardPass, true, JSON.stringify(result.messageEvaluation));
  assert.match(result.message!.content, /止损（需批准）/);
  const markdown = renderMessageReport([result]);
  assert.ok(markdown.includes(result.message!.content));
  assert.match(markdown, /scripted\/deterministic/);
  const bad = structuredClone(output);
  bad.diagnosis!.actions[0]!.evidenceIds = ['invented'];
  bad.diagnosis!.actions[0]!.target = '';
  const check = evaluateMessage(sample.messageOracle!, bad, [], sample.evidence, 'x'.repeat(4001));
  assert.equal(check.checks.citationsExist!.status, 'fail');
  assert.equal(check.checks.actionsComplete!.status, 'fail');
  assert.equal(check.checks.messageWithinLimit!.status, 'fail');
  assert.equal(check.checks.mitigationVisible!.status, 'fail');
  bad.hypothesis = '确认库存不足';
  assert.equal(evaluateMessage(sample.messageOracle!, bad, [], sample.evidence, '').checks.forbiddenAttributionScreen!.status, 'fail');
});

it('records billed usage from a rejected specialist and stops before a run above the reserve', async () => {
  const fake = createFakeRuntimeModel();
  const model = { ...fake, async invoke() { return { text: '{}', inputTokens: 12, outputTokens: 34 }; } };
  const result = await runCase(MESSAGE_CASES[3]!, { model, mode: 'live', thinkingLevel: 'off' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.tokenUsage, { input: 12, output: 34, total: 46 });
  await assert.rejects(runBenchmark({ cases: [MESSAGE_CASES[3]!], model: fake, mode: 'fake', thinkingLevel: 'off', tokenBudget: 1 }), /token budget/);
});
