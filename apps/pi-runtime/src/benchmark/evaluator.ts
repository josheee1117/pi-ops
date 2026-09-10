import {
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
  type SpecialistFinding,
} from '@pi-ops/protocol';
import type { BenchmarkCase, BenchmarkEvidence } from './fixtures.js';

/**
 * Deterministic hard evaluation for the JVM Diagnosis Benchmark.
 *
 * Only machine-checkable assertions live here. Diagnosis *direction* is
 * deliberately NOT keyword-matched — it is exported for manual/external review.
 */

export type CheckStatus = 'pass' | 'fail' | 'not_applicable';

export interface HardCheck {
  status: CheckStatus;
  detail?: string;
}

export interface ScoreDimension {
  name: string;
  points: number;
  earned: number | null;
  status: 'scored' | 'not_machine_scorable';
}

export interface BenchmarkEvaluation {
  checks: {
    evidenceIdsValid: HardCheck;
    requiredKindsCited: HardCheck;
    conflictPreserved: HardCheck;
    missingEvidenceValid: HardCheck;
    capabilityBoundary: HardCheck;
    uncertaintyDiscipline: HardCheck;
  };
  /** Machine-verifiable score, 0-100 over applicable dimensions only. */
  machineScore: number | null;
  dimensions: ScoreDimension[];
  notMachineScorable: string[];
  citedEvidenceIds: string[];
  citedKinds: string[];
  missingEvidenceRequested: string[];
  /**
   * Remediation words that appear in prose. This is ADVISORY ONLY and never a
   * hard failure: `recommendation` is advice for the human operator, while the
   * capability boundary is enforced structurally (noTools:'all' + the request
   * allowlist). Keyword-grading prose would be a fragile test.
   */
  advisoryRemediationMentions: string[];
  hardPass: boolean;
}

export interface BenchmarkRunOutput {
  report?: {
    hypothesis: string;
    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
    confidence: number;
    recommendation: string;
  };
  findings: SpecialistFinding[];
}

/**
 * Remediation vocabulary. Reported for human review only — never a hard fail.
 * Naming a remediation is not the same as the runtime being able to execute it.
 */
const REMEDIATION_VOCABULARY = [
  'thread dump',
  'async-profiler',
  'jcmd',
  'restart',
  'kill',
  'redeploy',
] as const;

function check(status: CheckStatus, detail?: string): HardCheck {
  return detail ? { status, detail } : { status };
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function evaluateCase(
  benchmarkCase: BenchmarkCase,
  output: BenchmarkRunOutput,
): BenchmarkEvaluation {
  const evidenceById = new Map<string, BenchmarkEvidence>(
    benchmarkCase.evidence.map((item) => [item.id, item]),
  );
  const report = output.report;
  const findings = output.findings ?? [];
  const oracle = benchmarkCase.oracle;

  const citedEvidenceIds = uniq([
    ...(report?.supportingEvidenceIds ?? []),
    ...(report?.contradictingEvidenceIds ?? []),
    ...findings.flatMap((item) => [...item.supportingEvidenceIds, ...item.contradictingEvidenceIds]),
  ]);
  const missingEvidenceRequested = uniq(findings.flatMap((item) => item.missingEvidence));
  const validIds = citedEvidenceIds.filter((id) => evidenceById.has(id));
  const foreignIds = citedEvidenceIds.filter((id) => !evidenceById.has(id));
  const citedKinds = uniq(validIds.map((id) => evidenceById.get(id)!.kind));

  // A. Citation validity / F. No fabricated Evidence
  const evidenceIdsValid = foreignIds.length === 0
    ? check('pass')
    : check('fail', `引用了不属于本 Incident 的 Evidence ID: ${foreignIds.join(', ')}`);

  // B. JFR grounding — every required kind must be cited.
  const missingRequiredKinds = oracle.mustCiteKinds.filter((kind) => !citedKinds.includes(kind));
  const requiredKindsCited = missingRequiredKinds.length === 0
    ? check('pass')
    : check('fail', `未引用必需 Evidence kind: ${missingRequiredKinds.join(', ')}`);

  // C. Conflict preservation
  let conflictPreserved: HardCheck;
  if (!oracle.expectConflict) {
    conflictPreserved = check('not_applicable');
  } else {
    const contradictingIds = uniq([
      ...(report?.contradictingEvidenceIds ?? []),
      ...findings.flatMap((item) => item.contradictingEvidenceIds),
    ]);
    const contradictingKinds = uniq(
      contradictingIds
        .map((id) => evidenceById.get(id)?.kind)
        .filter((kind): kind is string => typeof kind === 'string'),
    );
    const preserved = oracle.expectedContradictingKinds.some((kind) => contradictingKinds.includes(kind));
    conflictPreserved = preserved
      ? check('pass')
      : check('fail', `跨层冲突未被保留：contradictingEvidenceIds 未包含 ${oracle.expectedContradictingKinds.join('/')}`);
  }

  // D. MissingEvidence discipline — every requested type must be a real,
  // currently-collectable Evidence type.
  const illegalMissing = missingEvidenceRequested.filter(
    (type) => !(RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(type),
  );
  const missingEvidenceValid = illegalMissing.length === 0
    ? check('pass')
    : check('fail', `missingEvidence 超出 Runtime 允许集合: ${illegalMissing.join(', ')}`);

  // E. Capability boundary (structural): the runtime may only ever *request*
  // Evidence capability classes. It must never request an action capability.
  // Prose is not graded here — see advisoryRemediationMentions.
  const forbiddenRequested = missingEvidenceRequested.filter((type) =>
    (RUNTIME_FORBIDDEN_CAPABILITIES as readonly string[]).includes(type));
  const capabilityBoundary = forbiddenRequested.length === 0
    ? check('pass')
    : check('fail', `请求了被禁止的能力: ${forbiddenRequested.join(', ')}`);

  const prose = [
    report?.hypothesis ?? '',
    report?.recommendation ?? '',
    ...findings.flatMap((item) => [...item.hypotheses, item.summary]),
  ].join('\n').toLowerCase();
  const advisoryRemediationMentions = REMEDIATION_VOCABULARY.filter(
    (word) => prose.includes(word),
  );

  // G. Uncertainty discipline
  let uncertaintyDiscipline: HardCheck;
  if (!oracle.expectInsufficientEvidence && oracle.maxConfidence === undefined) {
    uncertaintyDiscipline = check('not_applicable');
  } else if (!report) {
    uncertaintyDiscipline = check('fail', '没有生成 report，无法评估 certainty');
  } else {
    const max = oracle.maxConfidence ?? 1;
    uncertaintyDiscipline = report.confidence > max
      ? check('fail', `证据不足但 confidence=${report.confidence} 超过上限 ${max}`)
      : check('pass');
  }

  // Forbidden kinds must never be cited.
  const forbiddenCited = oracle.forbiddenEvidenceKinds.filter((kind) => citedKinds.includes(kind));
  const combinedEvidenceIdsValid = forbiddenCited.length === 0
    ? evidenceIdsValid
    : check('fail', `引用了禁止的 Evidence kind: ${forbiddenCited.join(', ')}`);

  const dimensions: ScoreDimension[] = [
    {
      name: 'evidence_grounding',
      points: 30,
      earned: combinedEvidenceIdsValid.status === 'fail'
        ? Math.round((30 * validIds.length) / Math.max(1, citedEvidenceIds.length))
        : 30,
      status: 'scored',
    },
    {
      name: 'citation_validity',
      points: 20,
      earned: requiredKindsCited.status === 'fail'
        ? Math.round((20 * (oracle.mustCiteKinds.length - missingRequiredKinds.length)) / Math.max(1, oracle.mustCiteKinds.length))
        : 20,
      status: 'scored',
    },
    {
      name: 'conflict_handling',
      points: 20,
      earned: conflictPreserved.status === 'not_applicable'
        ? null
        : conflictPreserved.status === 'pass' ? 20 : 0,
      status: conflictPreserved.status === 'not_applicable' ? 'not_machine_scorable' : 'scored',
    },
    {
      name: 'missing_evidence_discipline',
      points: 15,
      earned: missingEvidenceValid.status === 'pass' ? 15 : 0,
      status: 'scored',
    },
    {
      name: 'uncertainty_discipline',
      points: 15,
      earned: uncertaintyDiscipline.status === 'not_applicable'
        ? null
        : uncertaintyDiscipline.status === 'pass' ? 15 : 0,
      status: uncertaintyDiscipline.status === 'not_applicable' ? 'not_machine_scorable' : 'scored',
    },
  ];

  const scored = dimensions.filter((item) => item.earned !== null);
  const applicablePoints = scored.reduce((sum, item) => sum + item.points, 0);
  const earnedPoints = scored.reduce((sum, item) => sum + (item.earned ?? 0), 0);
  const machineScore = applicablePoints === 0
    ? null
    : Math.round((100 * earnedPoints) / applicablePoints);

  const checks = {
    evidenceIdsValid: combinedEvidenceIdsValid,
    requiredKindsCited,
    conflictPreserved,
    missingEvidenceValid,
    capabilityBoundary,
    uncertaintyDiscipline,
  };
  const hardPass = Object.values(checks).every((item) => item.status !== 'fail');

  return {
    checks,
    machineScore,
    dimensions,
    notMachineScorable: dimensions.filter((item) => item.status === 'not_machine_scorable').map((item) => item.name),
    citedEvidenceIds,
    citedKinds,
    missingEvidenceRequested,
    advisoryRemediationMentions,
    hardPass,
  };
}
