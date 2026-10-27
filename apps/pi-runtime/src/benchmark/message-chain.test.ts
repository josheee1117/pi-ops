import { deterministicSummary, investigationReportInputSchema } from '@pi-ops/protocol';
import { readFileSync } from 'node:fs';
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
      summary: deterministicSummary({ type: 'business.error', service: 'dataasset' }),
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

function savedPlainMessage() {
  const saved = JSON.parse(readFileSync(new URL('results/2026-10-22-closed-loop/stack-overflow.json', import.meta.url), 'utf8'));
  return { report: investigationReportInputSchema.parse(saved.result.diagnosis.report), message: String(saved.result.message.content) };
}

it('accepts a recorded free-text summary with complete actions in the diagnosis', () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow')!;
  const saved = savedPlainMessage();
  assert.doesNotMatch(saved.message, /止损：|修复：|验证：/);
  const evaluation = evaluateMessage(sample.messageOracle!, saved.report, [], sample.evidence, saved.message);
  assert.equal(evaluation.hardPass, true, JSON.stringify(evaluation));
});

it('rejects missing mitigation even when the message still recommends stopping loss', () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow')!;
  const saved = savedPlainMessage();
  saved.report.diagnosis!.actions = saved.report.diagnosis!.actions.filter((action) => action.purpose !== 'mitigation');
  const evaluation = evaluateMessage(sample.messageOracle!, saved.report, [], sample.evidence, `${saved.message}\n止损：经批准隔离流量。`);
  assert.equal(evaluation.hardPass, false);
  assert.equal(evaluation.checks.mitigationInDiagnosis!.status, 'fail');
});

it('warns instead of failing a saved ordinary sop 404 without mitigation', () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'sop-404')!;
  const saved = JSON.parse(readFileSync(new URL('results/2026-10-22-closed-loop/sop-404.json', import.meta.url), 'utf8')).result;
  const diagnosis = investigationReportInputSchema.parse(saved.diagnosis.report);
  const evaluation = evaluateMessage(sample.messageOracle!, diagnosis, [], sample.evidence, saved.message.content);
  assert.equal(evaluation.checks.mitigationInDiagnosis!.status, 'warn');
  assert.equal(evaluation.hardPass, true, JSON.stringify(evaluation));
});

it('requires mitigation at high severity and for unavailable evidence even with a general summary', () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow')!;
  const saved = savedPlainMessage();
  saved.report.diagnosis!.actions = saved.report.diagnosis!.actions.filter((action) => action.purpose !== 'mitigation');
  for (const level of ['高', '严重'] as const) {
    saved.report.diagnosis!.summary!.severity = { level, reason: '关键接口失败。' };
    assert.equal(evaluateMessage(sample.messageOracle!, saved.report, [], sample.evidence, saved.message).checks.mitigationInDiagnosis!.status, 'fail');
  }
  saved.report.diagnosis!.summary!.severity = { level: '一般', reason: '模型未识别不可用风险。' };
  const generalMessage = saved.message.replace('严重程度：严重', '严重程度：一般');
  for (const id of ['jvm-heap-oom', 'health-503', 'stack-overflow']) {
    const unavailable = MESSAGE_CASES.find((item) => item.id === id)!;
    assert.equal(evaluateMessage(unavailable.messageOracle!, saved.report, [], unavailable.evidence, generalMessage).checks.mitigationInDiagnosis!.status, 'fail', id);
  }
});

it('requires mitigation for a rendered high severity or a stopped container even when the model reports general severity', () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'sop-404')!;
  const diagnosis = report();
  diagnosis.diagnosis!.actions = diagnosis.diagnosis!.actions.filter((action) => action.purpose !== 'mitigation');
  assert.equal(evaluateMessage(sample.messageOracle!, diagnosis, [], sample.evidence, '严重程度：高，关键接口失败。').checks.mitigationInDiagnosis!.status, 'fail');
  const stopped = [{ ...sample.evidence[0]!, kind: 'docker.inspect', data: { State: { Running: false, Status: 'exited' } } }];
  assert.equal(evaluateMessage(sample.messageOracle!, diagnosis, [], stopped, '').checks.mitigationInDiagnosis!.status, 'fail');
});

it('checks rendered recovery bounds, detail access, and repair or explicit uncertainty', () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow')!;
  const saved = savedPlainMessage();
  const evaluate = (message: string) => evaluateMessage(sample.messageOracle!, saved.report, [], sample.evidence, message);
  for (const message of [
    saved.message.replace(/\n[123]\. [^\n]+/g, ''),
    saved.message.replace('\n编号：', '\n4. 多余建议\n编号：'),
    saved.message.replace('Bearer', 'Basic'),
    saved.message.replace('1. ', `1. ${'长'.repeat(101)}`),
    `${saved.message}\n**依据**\n完整异常栈`,
    `${saved.message}\n## 完整诊断\n详细段落`,
    `${saved.message}\n依据：详细证据`,
    `${saved.message}\n\`\`\`json\n{}\n\`\`\``,
    saved.message.replace('1. ', '2. '),
    'x'.repeat(4001),
  ]) assert.equal(evaluate(message).hardPass, false, message);
  saved.report.diagnosis!.summary!.scene = '';
  assert.equal(evaluate(saved.message).checks.plainSummary!.status, 'fail');
  saved.report.diagnosis!.summary!.scene = '故障场景';
  saved.report.diagnosis!.actions = saved.report.diagnosis!.actions.filter((action) => action.purpose !== 'repair');
  assert.equal(evaluate(saved.message).checks.repairOrUnknown!.status, 'fail');
  assert.equal(evaluate(`${saved.message}\n修复尚未确定。`).hardPass, true);
  saved.report.diagnosis!.uncertainties.push('修复方案尚未确定，需核对源码。');
  assert.equal(evaluate(saved.message).hardPass, true);
  saved.report.diagnosis!.actions = saved.report.diagnosis!.actions.filter((action) => action.purpose !== 'verification');
  assert.equal(evaluate(saved.message).checks.verificationInDiagnosis!.status, 'fail');
});

it('runs the real notifier with fake fetch and checks action completeness, bytes, and all diagnosis citations', async () => {
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
  assert.match(result.message!.content, /止损：.*经批准/);
  assert.match(result.message!.content, /brief\?format=markdown/);
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
  assert.equal(check.checks.recoverySuggestions!.status, 'fail');
  bad.hypothesis = '确认库存不足';
  assert.equal(evaluateMessage(sample.messageOracle!, bad, [], sample.evidence, '').checks.forbiddenAttributionScreen!.status, 'fail');
});

it('renders all seven cases in fake mode with bounded summaries and detail links without network calls', async () => {
  for (const sample of MESSAGE_CASES) {
    const model = createFakeRuntimeModel();
    const result = await runCase(sample, { model, mode: 'fake', thinkingLevel: 'off' });
    assert.equal(result.status, 'completed', sample.id);
    assert.equal(result.message?.fetchCalls, 1, sample.id);
    const checks = result.messageEvaluation!.checks;
    for (const name of ['plainSummary', 'recoverySuggestions', 'detailAddress', 'noDetailedSections', 'messageWithinLimit']) {
      assert.equal(checks[name]!.status, 'pass', `${sample.id}: ${name}`);
    }
    assert.equal(checks.verificationInDiagnosis!.status, 'fail');
    assert.equal(result.messageEvaluation?.hardPass, false, 'default fake diagnosis has no verification action');
    assert.equal(model.networkCalls, 0);
    for (const label of ['场景：', '发生了什么：', '严重程度：', '恢复建议：', '编号：', 'http://127.0.0.1:8080/v1/ops/incidents/']) assert.ok(result.message!.content.includes(label), `${sample.id}: ${label}`);
  }
});

it('records billed usage from a rejected specialist and stops before a run above the reserve', async () => {
  const fake = createFakeRuntimeModel();
  const model = { ...fake, async invoke() { return { text: '{}', inputTokens: 12, outputTokens: 34 }; } };
  const result = await runCase(MESSAGE_CASES[3]!, { model, mode: 'live', thinkingLevel: 'off' });
  assert.equal(result.status, 'completed');
  assert.match(result.investigation.report?.hypothesis ?? '', /诊断不完整/);
  assert.match(result.message?.content ?? '', /诊断不完整/);
  assert.equal(result.message?.fetchCalls, 1);
  assert.deepEqual(result.tokenUsage, { input: 24, output: 68, total: 92 });
  await assert.rejects(runBenchmark({ cases: [MESSAGE_CASES[3]!], model: fake, mode: 'fake', thinkingLevel: 'off', tokenBudget: 1 }), /token budget/);
});
