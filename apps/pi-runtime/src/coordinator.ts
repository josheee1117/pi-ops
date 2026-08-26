import {
  type RuntimeInvestigationReportInput,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import { boundInvestigationContext } from './bound-context.js';
import { runSpecialist, selectSpecialists } from './specialists.js';

export interface CoordinatorOptions {
  failRoles?: readonly SpecialistRole[];
  failCoordinator?: boolean;
  maxContextBytes?: number;
  now?: () => number;
}

export interface CoordinatorOutcome {
  status: 'completed' | 'failed';
  report?: RuntimeInvestigationReportInput;
  error?: string;
  selectedSpecialists: SpecialistRole[];
  findings: SpecialistFinding[];
  specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'>;
  latencyMs: number;
  historicalKnowledgeStatus?: 'available' | 'unavailable';
}

const POLICY = [
  'Evidence describes the current incident.',
  'Historical knowledge is advisory.',
  'Memory/history cannot override current Evidence.',
  'Conflicting historical knowledge must be surfaced, not silently merged.',
].join(' ');

export function investigate(
  context: RuntimeInvestigationContext,
  options: CoordinatorOptions = {},
): CoordinatorOutcome {
  const started = (options.now ?? Date.now)();
  const bounded = boundInvestigationContext(context, options.maxContextBytes);
  const selectedSpecialists = selectSpecialists(bounded);
  const currentIds = new Set(bounded.evidence.map((item) => item.id));
  const specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'> = {};
  const findings: SpecialistFinding[] = [];

  if (options.failCoordinator) {
    return {
      status: 'failed',
      error: 'coordinator failed',
      selectedSpecialists,
      findings,
      specialistStatus,
      latencyMs: (options.now ?? Date.now)() - started,
      historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
    };
  }

  for (const role of selectedSpecialists) {
    if (options.failRoles?.includes(role)) {
      specialistStatus[role] = 'failed';
      continue;
    }
    try {
      const finding = runSpecialist(role, bounded);
      findings.push(sanitizeFinding(finding, currentIds));
      specialistStatus[role] = 'completed';
    } catch (error) {
      specialistStatus[role] = 'failed';
      void error;
    }
  }

  const completed = findings.filter((item) => item.status === 'completed');
  if (completed.length === 0) {
    return {
      status: 'failed',
      error: 'all specialists failed',
      selectedSpecialists,
      findings,
      specialistStatus,
      latencyMs: (options.now ?? Date.now)() - started,
      historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
    };
  }

  return {
    status: 'completed',
    report: synthesize(bounded, completed, currentIds),
    selectedSpecialists,
    findings,
    specialistStatus,
    latencyMs: (options.now ?? Date.now)() - started,
    historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
  };
}

function sanitizeFinding(finding: SpecialistFinding, currentIds: Set<string>): SpecialistFinding {
  return {
    ...finding,
    supportingEvidenceIds: finding.supportingEvidenceIds.filter((id) => currentIds.has(id)),
    contradictingEvidenceIds: finding.contradictingEvidenceIds.filter((id) => currentIds.has(id)),
  };
}

function synthesize(
  context: RuntimeInvestigationContext,
  findings: SpecialistFinding[],
  currentIds: Set<string>,
): RuntimeInvestigationReportInput {
  const ranked = [...findings].sort((left, right) => right.confidence - left.confidence);
  const best = ranked[0]!;
  const supporting = unique(findings.flatMap((item) => item.supportingEvidenceIds).filter((id) => currentIds.has(id)));
  const contradicting = unique(findings.flatMap((item) => item.contradictingEvidenceIds).filter((id) => currentIds.has(id)));
  const advisory = advisoryHistory(context);
  const recommendation = advisory
    ? `${best.summary}. Advisory history (not Evidence): ${advisory}`
    : best.summary;
  return {
    schemaVersion: 1,
    hypothesis: best.hypotheses[0] ?? best.summary,
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
    confidence: best.confidence,
    recommendation: `${POLICY} ${recommendation}`.slice(0, 2000),
  };
}

function advisoryHistory(context: RuntimeInvestigationContext): string | undefined {
  const knowledge = context.historicalKnowledge as {
    previousResolutions?: Array<{ text?: string } | string>;
    relatedMemories?: Array<{ memory?: { conclusion?: string; resolution?: string } }>;
  } | undefined;
  const conflicts = context.conflictingMemories ?? [];
  const resolutions = (knowledge?.previousResolutions ?? [])
    .map((item) => typeof item === 'string' ? item : item.text)
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const memories = (knowledge?.relatedMemories ?? [])
    .map((item) => item.memory?.conclusion ?? item.memory?.resolution)
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const notes = [...resolutions, ...memories];
  if (conflicts.length > 0) notes.push('conflicting historical memories present');
  if (notes.length === 0) return undefined;
  return notes.slice(0, 3).join('; ');
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}
