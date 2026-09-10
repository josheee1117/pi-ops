import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorReasonCodes,
  explainReasonCode,
  renderGovernanceSummary,
} from './human-summary.mjs';

const REJECT_INPUT = {
  detectDecision: 'REJECT',
  detectRoute: 'NONE',
  finalResult: 'FAIL',
  machineReviewResult: 'skipped',
  authorizeResult: 'skipped',
  reasonCodes: ['PROOF_SOURCE_CHANGED'],
  changedFiles: ['apps/agent/src/__tests__/jfr-evidence.test.ts'],
};

test('A. deterministic reject rendering is explicit and non-AI', () => {
  const text = renderGovernanceSummary(REJECT_INPUT);
  assert.match(text, /禁止合并/);
  assert.match(text, /确定性规则拒绝/);
  assert.match(text, /已登记的证明源发生变化/);
  assert.match(text, /PROOF_SOURCE_CHANGED/);
  assert.match(text, /apps\/agent\/src\/__tests__\/jfr-evidence\.test\.ts/);
  assert.doesNotMatch(text, /AI 自动审查通过/);
});

test('B. machine review pass renders AI approval and both roles', () => {
  const text = renderGovernanceSummary({
    detectDecision: 'HUMAN_REQUIRED',
    detectRoute: 'MACHINE_REVIEW',
    finalResult: 'PASS',
    machineReviewResult: 'success',
    authorizeResult: 'skipped',
    reasonCodes: ['GOVERNANCE_ENGINE_CHANGED'],
    reviewer: { decision: 'APPROVE', blockingFindings: [], riskNotes: ['当前仅覆盖 jvm.cpu_pressure'], summary: '没有扩大 Runtime 权限边界。' },
    critic: { decision: 'APPROVE', blockingFindings: [], riskNotes: [], summary: '未发现治理削弱。' },
  });
  assert.match(text, /AI 自动审查通过/);
  assert.match(text, /Reviewer：✅ 通过/);
  assert.match(text, /Critic：✅ 通过/);
  assert.match(text, /人工确认：不需要/);
  assert.match(text, /没有扩大 Runtime 权限边界。/);
  assert.match(text, /当前仅覆盖 jvm\.cpu_pressure/);
});

test('C. machine review rejection is not reported as deterministic reject', () => {
  const text = renderGovernanceSummary({
    detectDecision: 'HUMAN_REQUIRED',
    detectRoute: 'MACHINE_REVIEW',
    finalResult: 'FAIL',
    machineReviewResult: 'failure',
    authorizeResult: 'skipped',
    reviewer: { decision: 'REJECT', blockingFindings: ['新增了未登记的信任边'], riskNotes: [], summary: '证据不足。' },
    critic: { decision: 'APPROVE', blockingFindings: [], riskNotes: [], summary: '无额外发现。' },
  });
  assert.match(text, /AI Reviewer 拒绝/);
  assert.match(text, /新增了未登记的信任边/);
  assert.doesNotMatch(text, /这是 \*\*确定性规则拒绝\*\*/);
  assert.doesNotMatch(text, /结果：❌ 禁止合并\*\*/);
});

test('D. break glass asks for owner intent without line-by-line review', () => {
  const text = renderGovernanceSummary({
    detectDecision: 'HUMAN_REQUIRED',
    detectRoute: 'BREAK_GLASS',
    finalResult: 'FAIL',
    authorizeResult: 'skipped',
    reasonCodes: ['TRUST_ROOT_CHANGED'],
    changedFiles: ['tools/test-governance/trust-anchor/check.mjs'],
  });
  assert.match(text, /需要仓库所有者确认/);
  assert.match(text, /不需要逐行 Review/);
  assert.match(text, /governance-review/);
  assert.match(text, /TRUST_ROOT_CHANGED/);
});

test('D2. acknowledged break glass reports owner confirmation', () => {
  const text = renderGovernanceSummary({
    detectDecision: 'HUMAN_REQUIRED',
    detectRoute: 'BREAK_GLASS',
    finalResult: 'PASS',
    authorizeResult: 'success',
    reasonCodes: ['TRUST_ROOT_CHANGED'],
  });
  assert.match(text, /仓库所有者已确认/);
  assert.match(text, /可以继续/);
});

test('E. unknown reason code falls back safely without crashing', () => {
  assert.equal(explainReasonCode('SOME_FUTURE_CODE'), '未知治理原因：SOME_FUTURE_CODE');
  assert.equal(explainReasonCode(''), '未知治理原因：<empty>');
  assert.equal(explainReasonCode(undefined), '未知治理原因：<empty>');
  const text = renderGovernanceSummary({ ...REJECT_INPUT, reasonCodes: ['SOME_FUTURE_CODE'] });
  assert.match(text, /未知治理原因：SOME_FUTURE_CODE/);
  assert.match(text, /禁止合并/);
});

test('E2. missing and null inputs still render a safe verdict block', () => {
  for (const input of [undefined, null, {}, { detectDecision: 'INTERNAL_ERROR' }]) {
    const text = renderGovernanceSummary(input);
    assert.equal(typeof text, 'string');
    assert.match(text, /## 🤖 Pi-Ops 自动治理结果/);
  }
});

test('F. renderer never mutates its input and returns text only', () => {
  const input = {
    detectDecision: 'HUMAN_REQUIRED',
    detectRoute: 'MACHINE_REVIEW',
    finalResult: 'PASS',
    machineReviewResult: 'success',
    reasonCodes: ['GOVERNANCE_ENGINE_CHANGED'],
    changedFiles: ['tools/test-governance/src/core.mjs'],
    labels: ['MACHINE_REVIEW_SURFACE_CHANGED'],
    reviewer: { decision: 'APPROVE', blockingFindings: [], riskNotes: [], summary: '无风险。' },
    critic: { decision: 'APPROVE', blockingFindings: [], riskNotes: [], summary: '无风险。' },
  };
  const before = structuredClone(input);
  const text = renderGovernanceSummary(input);
  assert.deepEqual(input, before);
  assert.equal(typeof text, 'string');
});

test('F2. renderer has no authorization vocabulary in its output decisions', () => {
  const text = renderGovernanceSummary({ detectDecision: 'PASS', detectRoute: 'NONE', finalResult: 'PASS' });
  assert.match(text, /可以合并/);
  // Display text must not invent machine decisions.
  assert.doesNotMatch(text, /decision\s*[:：]\s*(APPROVE|REJECT|MACHINE_REVIEW)/i);
});

test('anchorReasonCodes collects detector codes deterministically', () => {
  const codes = anchorReasonCodes({
    authorization: { reasonCodes: ['PROOF_WEAKENING'], labels: ['KERNEL_CHANGED', 'PROOF_WEAKENING'] },
    proofIntegrity: { changedSources: [{ kind: 'PROOF_SOURCE_CHANGED' }], changedDefinitions: [], newProofs: [] },
    trustSurface: { findings: [{ kind: 'GOVERNANCE_ENGINE_CHANGED' }] },
  });
  assert.deepEqual(codes, ['GOVERNANCE_ENGINE_CHANGED', 'KERNEL_CHANGED', 'PROOF_SOURCE_CHANGED', 'PROOF_WEAKENING']);
  assert.deepEqual(anchorReasonCodes(null), []);
});
