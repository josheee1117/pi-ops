import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  validateRuntimeInvestigationContext,
  validateSpecialistFinding,
} from '@pi-ops/protocol';
import { createFakeRuntimeModel } from '../model.js';
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  UnsupportedThinkingLevelError,
  parseThinkingLevel,
} from '../thinking-level.js';
import { buildBenchmarkContext, CPU_GOLDEN_CASES, findCase } from './fixtures.js';
import { evaluateCase } from './evaluator.js';
import { buildReport, renderMarkdown } from './report.js';
import { describeThinking, resolveCases, runBenchmark, runCase, usageOrNull } from './runner.js';

const SECRET = 'sk-benchmark-secret-value-abcdef123456';

describe('JVM diagnosis benchmark fixtures', () => {
  it('A. every golden case context passes the real protocol schema', () => {
    assert.ok(CPU_GOLDEN_CASES.length >= 6);
    for (const benchmarkCase of CPU_GOLDEN_CASES) {
      const context = buildBenchmarkContext(benchmarkCase);
      const result = validateRuntimeInvestigationContext(context);
      assert.equal(result.success, true, `${benchmarkCase.id}: ${result.success ? '' : result.message}`);
      assert.ok(benchmarkCase.evidence.length > 0);
      assert.ok(benchmarkCase.oracle.expectedDirection.length > 0);
      // Every evidence id must be unique and bound to the case incident.
      const ids = benchmarkCase.evidence.map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, benchmarkCase.id);
      for (const item of benchmarkCase.evidence) {
        assert.equal(item.incidentId, benchmarkCase.incidentId, benchmarkCase.id);
      }
    }
  });

  it('every mustCiteKind exists in that case evidence', () => {
    for (const benchmarkCase of CPU_GOLDEN_CASES) {
      const kinds = new Set(benchmarkCase.evidence.map((item) => item.kind));
      for (const kind of benchmarkCase.oracle.mustCiteKinds) {
        assert.ok(kinds.has(kind), `${benchmarkCase.id}: mustCiteKind ${kind} missing from evidence`);
      }
    }
  });

  it('only jvm.cpu_pressure is benchmarked in v1', () => {
    for (const benchmarkCase of CPU_GOLDEN_CASES) {
      for (const item of benchmarkCase.evidence) {
        if (item.kind === 'jfr.signal') {
          assert.equal((item.data as { eventType: string }).eventType, 'jvm.cpu_pressure');
        }
      }
    }
  });

  it('B. the fake runtime completes every golden case deterministically', async () => {
    const results = await runBenchmark({
      model: createFakeRuntimeModel(),
      mode: 'fake',
      thinkingLevel: 'off',
    });
    assert.equal(results.length, CPU_GOLDEN_CASES.length);
    for (const result of results) {
      assert.equal(result.status, 'completed', `${result.caseId}: ${result.error ?? ''}`);
      assert.ok(result.investigation.report, `${result.caseId} produced no report`);
      assert.equal(result.tokenUsage, null);
      assert.equal(result.thinking.status, 'not_applicable');
    }
    const second = await runBenchmark({
      model: createFakeRuntimeModel(),
      mode: 'fake',
      thinkingLevel: 'off',
    });
    assert.deepEqual(
      results.map((item) => item.investigation.report?.hypothesis),
      second.map((item) => item.investigation.report?.hypothesis),
    );
  });
});

describe('benchmark evaluator', () => {
  const baseCase = findCase('cpu-jvm-and-host-high')!;

  it('C. detects a fabricated Evidence ID', () => {
    const evaluation = evaluateCase(baseCase, {
      report: {
        hypothesis: 'x',
        supportingEvidenceIds: ['evd-b1-jfr', 'evd-invented-999'],
        contradictingEvidenceIds: [],
        confidence: 0.7,
        recommendation: 'y',
      },
      findings: [],
    });
    assert.equal(evaluation.checks.evidenceIdsValid.status, 'fail');
    assert.match(evaluation.checks.evidenceIdsValid.detail ?? '', /evd-invented-999/);
    assert.equal(evaluation.hardPass, false);
  });

  it('D. detects Evidence from a foreign Incident', () => {
    const other = findCase('cpu-host-wide-only')!;
    const foreignId = other.evidence[0]!.id;
    const evaluation = evaluateCase(baseCase, {
      report: {
        hypothesis: 'x',
        supportingEvidenceIds: ['evd-b1-jfr', foreignId],
        contradictingEvidenceIds: [],
        confidence: 0.7,
        recommendation: 'y',
      },
      findings: [],
    });
    assert.equal(evaluation.checks.evidenceIdsValid.status, 'fail');
    assert.match(evaluation.checks.evidenceIdsValid.detail ?? '', new RegExp(foreignId));
  });

  it('fails when the case requires jfr.signal but nothing is cited', () => {
    const evaluation = evaluateCase(baseCase, {
      report: { hypothesis: 'x', supportingEvidenceIds: [], contradictingEvidenceIds: [], confidence: 0.5, recommendation: 'y' },
      findings: [],
    });
    assert.equal(evaluation.checks.requiredKindsCited.status, 'fail');
    assert.equal(evaluation.hardPass, false);
  });

  it('F. fails when the conflict case loses its contradicting Evidence', () => {
    const conflictCase = findCase('cpu-cross-layer-conflict')!;
    const lost = evaluateCase(conflictCase, {
      report: {
        hypothesis: 'jfr 说 CPU 高',
        supportingEvidenceIds: ['evd-b4-jfr'],
        contradictingEvidenceIds: [],
        confidence: 0.9,
        recommendation: 'restart',
      },
      findings: [],
    });
    assert.equal(lost.checks.conflictPreserved.status, 'fail');
    assert.equal(lost.hardPass, false);

    const kept = evaluateCase(conflictCase, {
      report: {
        hypothesis: 'jfr 与 host 采样存在冲突',
        supportingEvidenceIds: ['evd-b4-jfr'],
        contradictingEvidenceIds: ['evd-b4-load', 'evd-b4-stats'],
        confidence: 0.5,
        recommendation: 'continue observing',
      },
      findings: [],
    });
    assert.equal(kept.checks.conflictPreserved.status, 'pass');
    assert.equal(kept.hardPass, true);
  });

  it('E. fails a forbidden jfr.signal missingEvidence request', () => {
    const finding = validateSpecialistFinding({
      role: 'jvm',
      hypotheses: ['need jfr'],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: ['jfr.signal'],
      confidence: 0.4,
      summary: 'x',
      status: 'completed',
    });
    // The protocol already refuses it; the evaluator must also refuse it if a
    // finding reaches it from any other path.
    assert.equal(finding.success, false);

    const evaluation = evaluateCase(baseCase, {
      report: {
        hypothesis: 'x',
        supportingEvidenceIds: ['evd-b1-jfr'],
        contradictingEvidenceIds: [],
        confidence: 0.5,
        recommendation: 'y',
      },
      findings: [{
        role: 'jvm',
        hypotheses: ['h'],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: ['jfr.signal' as never],
        confidence: 0.5,
        summary: 's',
        status: 'completed',
      }],
    });
    assert.equal(evaluation.checks.missingEvidenceValid.status, 'fail');
    assert.equal(evaluation.hardPass, false);
  });

  it('G. fails a Runtime Evidence request outside the allowlist', () => {
    const evaluation = evaluateCase(baseCase, {
      report: { hypothesis: 'x', supportingEvidenceIds: ['evd-b1-jfr'], contradictingEvidenceIds: [], confidence: 0.5, recommendation: 'y' },
      findings: [{
        role: 'jvm',
        hypotheses: ['h'],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: ['shell.exec' as never],
        confidence: 0.5,
        summary: 's',
        status: 'completed',
      }],
    });
    assert.equal(evaluation.checks.missingEvidenceValid.status, 'fail');
  });

  it('accepts a request that stays inside RUNTIME_ALLOWED_EVIDENCE_TYPES', () => {
    const evaluation = evaluateCase(findCase('cpu-insufficient')!, {
      report: { hypothesis: 'x', supportingEvidenceIds: ['evd-b6-jfr'], contradictingEvidenceIds: [], confidence: 0.4, recommendation: 'y' },
      findings: [{
        role: 'jvm',
        hypotheses: ['h'],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: ['host.load', 'docker.stats'],
        confidence: 0.4,
        summary: 's',
        status: 'completed',
      }],
    });
    assert.equal(evaluation.checks.missingEvidenceValid.status, 'pass');
    for (const type of evaluation.missingEvidenceRequested) {
      assert.ok((RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(type));
    }
  });

  it('fails an unsupported-certainty report on the insufficient case', () => {
    const evaluation = evaluateCase(findCase('cpu-insufficient')!, {
      report: {
        hypothesis: '一定是 GC 导致',
        supportingEvidenceIds: ['evd-b6-jfr'],
        contradictingEvidenceIds: [],
        confidence: 0.97,
        recommendation: 'restart the JVM',
      },
      findings: [],
    });
    assert.equal(evaluation.checks.uncertaintyDiscipline.status, 'fail');
    assert.equal(evaluation.hardPass, false);
  });

  it('E. fails a request for a forbidden action capability', () => {
    const evaluation = evaluateCase(baseCase, {
      report: { hypothesis: 'x', supportingEvidenceIds: ['evd-b1-jfr'], contradictingEvidenceIds: [], confidence: 0.5, recommendation: 'y' },
      findings: [{
        role: 'jvm',
        hypotheses: ['h'],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: ['shell' as never],
        confidence: 0.5,
        summary: 's',
        status: 'completed',
      }],
    });
    assert.equal(evaluation.checks.capabilityBoundary.status, 'fail');
    assert.equal(evaluation.hardPass, false);
  });

  it('E2. prose that merely recommends a remediation is advisory, not a hard fail', () => {
    // `recommendation` is advice for the human operator. The capability boundary
    // is structural (noTools:'all'), so grading prose would be a fragile test.
    const evaluation = evaluateCase(baseCase, {
      report: {
        hypothesis: 'x',
        supportingEvidenceIds: ['evd-b1-jfr'],
        contradictingEvidenceIds: [],
        confidence: 0.5,
        recommendation: 'capture a thread dump or async-profiler flame graph to localize the hot method',
      },
      findings: [],
    });
    assert.equal(evaluation.checks.capabilityBoundary.status, 'pass');
    assert.ok(evaluation.advisoryRemediationMentions.includes('thread dump'));
    assert.ok(evaluation.advisoryRemediationMentions.includes('async-profiler'));
  });

  it('marks non-applicable dimensions NOT_MACHINE_SCORABLE instead of guessing', () => {
    const evaluation = evaluateCase(baseCase, {
      report: {
        hypothesis: 'x',
        supportingEvidenceIds: ['evd-b1-jfr', 'evd-b1-load', 'evd-b1-stats'],
        contradictingEvidenceIds: [],
        confidence: 0.6,
        recommendation: 'y',
      },
      findings: [],
    });
    assert.ok(evaluation.notMachineScorable.includes('conflict_handling'));
    assert.ok(evaluation.notMachineScorable.includes('uncertainty_discipline'));
    assert.equal(evaluation.machineScore, 100);
    assert.equal(evaluation.hardPass, true);
  });
});

describe('benchmark runner and report', () => {
  it('selects cases by id and rejects unknown ones', () => {
    assert.equal(resolveCases(['cpu-insufficient']).length, 1);
    assert.equal(resolveCases([]).length, CPU_GOLDEN_CASES.length);
    assert.throws(() => resolveCases(['does-not-exist']), /unknown benchmark case/);
  });

  it('H. thinking level defaults to off and unsupported values are rejected', () => {
    assert.equal(DEFAULT_THINKING_LEVEL, 'off');
    assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(parseThinkingLevel(undefined), 'off');
    assert.equal(parseThinkingLevel(''), 'off');
    assert.equal(parseThinkingLevel('high'), 'high');
    assert.throws(() => parseThinkingLevel('turbo'), UnsupportedThinkingLevelError);
    assert.throws(() => parseThinkingLevel('TURBO'), /unsupported thinking level/);
  });

  it('I. reports clamped / unsupported thinking instead of a silent fallback', () => {
    assert.deepEqual(
      describeThinking('high', 'high', 'live'),
      { requested: 'high', effective: 'high', status: 'honored' },
    );
    assert.deepEqual(
      describeThinking('high', 'off', 'live'),
      { requested: 'high', effective: 'off', status: 'clamped' },
    );
    assert.deepEqual(
      describeThinking('max', undefined, 'live'),
      { requested: 'max', effective: null, status: 'unsupported' },
    );
    assert.deepEqual(
      describeThinking('high', 'off', 'fake'),
      { requested: 'high', effective: null, status: 'not_applicable' },
    );
  });

  it('does not fabricate token usage for a provider that omits it', () => {
    const fakeOutcome = {
      status: 'completed' as const,
      selectedSpecialists: [],
      findings: [],
      specialistStatus: {},
      latencyMs: 1,
      provider: 'fake',
      model: 'deterministic',
      inputTokens: 0,
      outputTokens: 0,
    };
    assert.equal(usageOrNull(fakeOutcome, 'fake').usage, null);
    assert.match(usageOrNull(fakeOutcome, 'fake').note ?? '', /fake model/);
    assert.deepEqual(
      usageOrNull({ ...fakeOutcome, provider: 'x', inputTokens: 12, outputTokens: 34 }, 'live').usage,
      { input: 12, output: 34, total: 46 },
    );
  });

  it('J. output never contains a credential value', async () => {
    process.env['PI_OPS_PI_API_KEY'] = SECRET;
    const results = await runBenchmark({
      model: createFakeRuntimeModel(),
      mode: 'fake',
      thinkingLevel: 'off',
      caseIds: ['cpu-jvm-and-host-high'],
    });
    const report = buildReport(results);
    const json = JSON.stringify(report);
    const markdown = renderMarkdown(report);
    assert.equal(json.includes(SECRET), false);
    assert.equal(markdown.includes(SECRET), false);
    assert.equal(/sk-[a-z0-9-]{20,}/i.test(json), false);
    delete process.env['PI_OPS_PI_API_KEY'];
  });

  it('renders a report with per-case rows and the manual review section', async () => {
    const results = await runBenchmark({
      model: createFakeRuntimeModel(),
      mode: 'fake',
      thinkingLevel: 'off',
    });
    const markdown = renderMarkdown(buildReport(results));
    assert.match(markdown, /JVM Diagnosis Benchmark v1/);
    assert.match(markdown, /LIVE BENCHMARK|fake \(CI harness\)/);
    assert.match(markdown, /cpu-jvm-and-host-high/);
    assert.match(markdown, /语义质量（需人工\/外部评审）/);
  });

  it('captures per-invocation model output so a failed specialist stays explainable', async () => {
    // Reproduces the observed live failure mode: the model emits missingEvidence
    // as objects with reasons; the protocol accepts only bare type strings, so
    // the specialist is rejected AFTER invoke resolves.
    const payload = JSON.stringify({
      role: 'jvm',
      hypotheses: [{ id: 'h1', statement: 'cpu hotspot' }],
      supportingEvidenceIds: ['evd-b1-jfr'],
      contradictingEvidenceIds: [],
      missingEvidence: [{ type: 'docker.inspect', reason: 'check cgroup quota' }],
      confidence: 0.5,
      summary: 'x',
      status: 'completed',
    });
    const scripted = {
      ...createFakeRuntimeModel(),
      invoke: async () => ({ text: payload, provider: 'failfirst', model: 'scripted' }),
    };
    const result = await runCase(findCase('cpu-jvm-and-host-high')!, {
      model: scripted,
      mode: 'live',
      thinkingLevel: 'high',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.evaluation, null);
    const captured = result.modelCalls.filter((item) => item.status === 'ok');
    assert.ok(captured.length > 0);
    assert.ok(captured.every((item) => item.text && item.chars > 0));
    assert.match(captured[0]!.text!, /missingEvidence/);
    const markdown = renderMarkdown(buildReport([result]));
    assert.match(markdown, /specialist 失败原因/);
    assert.match(markdown, /输出未通过结构化校验/);
  });

  it('records a failed case without throwing', async () => {
    const broken = {
      ...createFakeRuntimeModel(),
      provider: 'fake',
      invoke: async () => {
        throw new Error('model exploded');
      },
    };
    const result = await runCase(findCase('cpu-insufficient')!, {
      model: broken,
      mode: 'live',
      thinkingLevel: 'high',
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /all specialists failed|model exploded/);
    assert.equal(result.evaluation, null);
  });
});
