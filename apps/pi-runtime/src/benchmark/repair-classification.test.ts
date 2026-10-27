import { it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRepair, snippetOnlyFacts } from './repair-classification.js';

const SNIPPET = {
  id: 'source-abc123',
  kind: 'source.snippet',
  text: [
    '@RestController',
    '@Profile("real-dataasset-lab")',
    '@ConditionalOnProperty(prefix = "lab.fault", name = "enabled", havingValue = "true", matchIfMissing = false)',
    'public final class LabFaultController {',
    '    @GetMapping("/auth/lab/server-fault")',
    '    public void serverFault() {',
    '        throw new IllegalStateException("Real DataAsset lab fault injection");',
    '    }',
    '}',
  ].join('\n'),
};
const OTHER = [
  'at com.mbkj.dap.lab.LabFaultController.serverFault(LabFaultController.java:25)',
  '2026-10-14 java.lang.IllegalStateException: Real DataAsset lab fault injection',
].join('\n');

function diagnosis(overrides: Record<string, unknown> = {}) {
  return {
    hypothesis: '请求命中注入端点。',
    recommendation: '核对入口。',
    uncertainties: [],
    actions: [],
    summary: { recovery: [] },
    ...overrides,
  };
}

it('finds facts that only the snippet carries', () => {
  const facts = snippetOnlyFacts(SNIPPET.text, OTHER);
  assert.ok(facts.has('lab.fault'), [...facts].join(','));
  assert.ok(!facts.has('LabFaultController'));
  assert.ok(!facts.has('serverFault'));
});

it('counts a repair that cites the snippet and names a snippet-only fact as real', () => {
  const kind = classifyRepair(diagnosis({
    actions: [{
      purpose: 'repair',
      operation: '移除或按环境收紧 @Profile 与 lab.fault 开关，然后发布。',
      evidenceIds: [SNIPPET.id],
    }],
  }), { snippets: [SNIPPET], otherEvidenceText: OTHER });
  assert.equal(kind, 'real_repair');
});

it('does not count a repair built only from facts already in the other evidence', () => {
  const kind = classifyRepair(diagnosis({
    actions: [{
      purpose: 'repair',
      operation: '核对 LabFaultController.java:25 的抛出条件后修复。',
      evidenceIds: [SNIPPET.id],
    }],
  }), { snippets: [SNIPPET], otherEvidenceText: OTHER });
  assert.equal(kind, 'fallback');
});

it('does not count a repair action that never cites the snippet id', () => {
  const kind = classifyRepair(diagnosis({
    actions: [{
      purpose: 'repair',
      operation: '移除 lab.fault.enabled 开关。',
      evidenceIds: ['evd-jfr'],
    }],
  }), { snippets: [SNIPPET], otherEvidenceText: OTHER });
  assert.equal(kind, 'fallback');
});

it('requires the snippet-only fact to come from the snippet the action cites', () => {
  const kind = classifyRepair(diagnosis({
    actions: [{ purpose: 'repair', operation: '修正 lab.fault 开关。', evidenceIds: ['source-other'] }],
  }), { snippets: [SNIPPET, { id: 'source-other', kind: 'source.snippet', text: 'void otherMethod() {}' }], otherEvidenceText: OTHER });
  assert.equal(kind, 'fallback');
});

it('does not treat a non-source evidence id as a snippet citation', () => {
  assert.equal(classifyRepair(diagnosis({
    actions: [{ purpose: 'repair', operation: '修正 lab.fault。', evidenceIds: [SNIPPET.id] }],
  }), { snippets: [{ ...SNIPPET, kind: 'docker.logs' }], otherEvidenceText: OTHER }), 'fallback');
});

it('recognizes undetermined repair text in an action', () => {
  assert.equal(classifyRepair(diagnosis({
    actions: [{ purpose: 'repair', operation: '修复尚未确定，先读取部署源码。', evidenceIds: [] }],
  }), { snippets: [], otherEvidenceText: OTHER }), 'undetermined');
});

it('classifies an explicit undetermined repair separately from a fallback claim', () => {
  const undetermined = classifyRepair(diagnosis({
    uncertainties: ['缺少对应版本的生效配置，修复尚未确定。'],
    actions: [{ purpose: 'evidence_collection', operation: '补充生效配置。', evidenceIds: [SNIPPET.id] }],
  }), { snippets: [SNIPPET], otherEvidenceText: OTHER });
  assert.equal(undetermined, 'undetermined');
  const fallback = classifyRepair(diagnosis({
    actions: [{ purpose: 'mitigation', operation: '经批准隔离流量。', evidenceIds: [SNIPPET.id] }],
  }), { snippets: [SNIPPET], otherEvidenceText: OTHER });
  assert.equal(fallback, 'fallback');
});
