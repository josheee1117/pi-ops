import {
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
  type SpecialistFinding,
  diagnosisEvidenceIds,
  investigationSummarySchema,
  type RuntimeInvestigationReportInput,
} from '@pi-ops/protocol';
import type { BenchmarkCase, BenchmarkEvidence } from './fixtures.js';
import type { MessageOracle } from './message-cases.js';

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
    diagnosisComplete: HardCheck;
  };
  /** The delivered report carries the production degradation marker. */
  degraded: boolean;
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
    diagnosis?: RuntimeInvestigationReportInput['diagnosis'];
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

export interface MessageEvaluation {
  checks: Record<string, HardCheck>;
  purposes: Record<string, { inDiagnosis: boolean; inMessage: boolean }>;
  forbiddenMatches: string[];
  degraded: boolean;
  hardPass: boolean;
}

/**
 * Production marks a degraded generation with these prefixes in
 * structured-output.ts. The benchmark reads the marker, it does not create one.
 */
export function diagnosisIsDegraded(report: RuntimeInvestigationReportInput | undefined): boolean {
  if (!report) return false;
  return report.hypothesis.startsWith('诊断不完整') || report.recommendation.startsWith('诊断不完整');
}

function degradedCheck(report: RuntimeInvestigationReportInput | undefined): HardCheck {
  if (!report) return { status: 'fail', detail: '没有生成结构化报告' };
  return diagnosisIsDegraded(report)
    ? { status: 'fail', detail: '诊断是降级产物：hypothesis 或 recommendation 带“诊断不完整”前缀' }
    : { status: 'pass' };
}

export function evaluateMessage(
  oracle: MessageOracle,
  report: RuntimeInvestigationReportInput | undefined,
  findings: SpecialistFinding[],
  evidence: BenchmarkEvidence[],
  message: string,
): MessageEvaluation {
  const actions = report?.diagnosis?.actions ?? [];
  const ids = new Set(evidence.map((item) => item.id));
  const cited = [...diagnosisEvidenceIds(report?.diagnosis), ...(report?.supportingEvidenceIds ?? []), ...(report?.contradictingEvidenceIds ?? []),
    ...findings.flatMap((finding) => [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds, ...diagnosisEvidenceIds(finding.diagnosis)])];
  const foreign = cited.filter((id) => !ids.has(id));
  const prose = [report?.hypothesis, report?.recommendation, JSON.stringify(report?.diagnosis), message,
    ...findings.flatMap((finding) => [finding.summary, ...finding.hypotheses, JSON.stringify(finding.diagnosis)])].join('\n');
  const forbiddenMatches = oracle.forbiddenClaimPatterns.flatMap((pattern) => prose.match(new RegExp(pattern, 'gi')) ?? []);
  const labels = { mitigation: '止损', repair: '修复', verification: '验证' };
  const purposes = Object.fromEntries(Object.entries(labels).map(([purpose, label]) => [purpose, {
    inDiagnosis: actions.some((action) => action.purpose === purpose),
    inMessage: new RegExp(`${label}(?:（需批准）)?：`).test(message),
  }]));
  const checks = {
    structuredDiagnosis: check(report?.diagnosis ? 'pass' : 'fail'),
    actionsComplete: check(actions.length > 0 && actions.every((action) => [action.target, action.operation, action.expectedResult].every((value) => value.trim().length > 0)) ? 'pass' : 'fail'),
    citationsExist: check(foreign.length === 0 ? 'pass' : 'fail', foreign.join(', ')),
    forbiddenAttributionScreen: check(forbiddenMatches.length === 0 ? 'pass' : 'fail', '固定断言模式筛查，不代表语义上不存在禁止归因。'),
    messageWithinLimit: check(Buffer.byteLength(message) <= 4000 ? 'pass' : 'fail', `${Buffer.byteLength(message)} bytes`),
    mitigationVisible: check(purposes.mitigation?.inMessage ? 'pass' : 'fail'),
    repairOrUnknownVisible: check(purposes.repair?.inMessage || message.includes('修复尚未确定') ? 'pass' : 'fail'),
    verificationVisible: check(purposes.verification?.inMessage ? 'pass' : 'fail'),
    plainSummary: check(investigationSummarySchema.safeParse(report?.diagnosis?.summary).success ? 'pass' : 'fail'),
    detailAddress: check(/\/v1\/ops\/incidents\/[^\s]+\/brief\?format=markdown/.test(message) && message.includes('Bearer') ? 'pass' : 'fail'),
    noDetailedSections: check(/\*\*(?:依据|未知|下一步)\*\*|模型自评|\n前提：|\n风险：/.test(message) ? 'fail' : 'pass'),
    diagnosisComplete: degradedCheck(report),
  };
  return { checks, purposes, forbiddenMatches, degraded: diagnosisIsDegraded(report), hardPass: Object.values(checks).every((item) => item.status !== 'fail') };
}

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
    ...diagnosisEvidenceIds(report?.diagnosis),
    ...findings.flatMap((item) => [...item.supportingEvidenceIds, ...item.contradictingEvidenceIds, ...diagnosisEvidenceIds(item.diagnosis)]),
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
    diagnosisComplete: degradedCheck(report),
  };
  const hardPass = Object.values(checks).every((item) => item.status !== 'fail');

  return {
    checks,
    degraded: diagnosisIsDegraded(report),
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
