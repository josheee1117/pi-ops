import {
  investigationReportInputSchema,
  type RuntimeInvestigationReportInput,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import { boundInvestigationContext, ContextTooLargeError } from './bound-context.js';
import { createFakeRuntimeModel, parseModelJson, type RuntimeModel } from './model.js';
import { runSpecialist, selectSpecialists } from './specialists.js';

export interface CoordinatorOptions {
  model?: RuntimeModel;
  failRoles?: readonly SpecialistRole[];
  failCoordinator?: boolean;
  maxContextBytes?: number;
  executionTimeoutMs?: number;
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
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const POLICY = [
  'Evidence describes the current incident.',
  'Historical knowledge is advisory.',
  'Memory/history cannot override current Evidence.',
  'Conflicting historical knowledge must be surfaced, not silently merged.',
].join(' ');

export async function investigate(
  context: RuntimeInvestigationContext,
  options: CoordinatorOptions = {},
): Promise<CoordinatorOutcome> {
  const started = (options.now ?? Date.now)();
  const model = options.model ?? createFakeRuntimeModel();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'> = {};
  const findings: SpecialistFinding[] = [];
  let selectedSpecialists: SpecialistRole[] = [];

  const timedOut = () => ({
    status: 'failed' as const,
    error: 'execution timeout',
    selectedSpecialists,
    findings,
    specialistStatus,
    latencyMs: (options.now ?? Date.now)() - started,
    historicalKnowledgeStatus: context.historicalKnowledgeStatus,
    provider: model.provider,
    model: model.model,
    ...usage,
  });

  const controller = new AbortController();
  const timer = options.executionTimeoutMs
    ? setTimeout(() => controller.abort(), options.executionTimeoutMs)
    : undefined;
  const onAbort = () => undefined;
  controller.signal.addEventListener('abort', onAbort);

  try {
    const bounded = boundInvestigationContext(context, options.maxContextBytes);
    selectedSpecialists = selectSpecialists(bounded);
    const currentIds = new Set(bounded.evidence.map((item) => item.id));

    if (options.failCoordinator) {
      return {
        status: 'failed',
        error: 'coordinator failed',
        selectedSpecialists,
        findings,
        specialistStatus,
        latencyMs: (options.now ?? Date.now)() - started,
        historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
        provider: model.provider,
        model: model.model,
        ...usage,
      };
    }

    for (const role of selectedSpecialists) {
      if (controller.signal.aborted) return timedOut();
      if (options.failRoles?.includes(role)) {
        specialistStatus[role] = 'failed';
        continue;
      }
      try {
        const result = await runSpecialist(role, bounded, model, controller.signal);
        usage.inputTokens += result.inputTokens;
        usage.outputTokens += result.outputTokens;
        findings.push(result.finding);
        specialistStatus[role] = 'completed';
      } catch {
        specialistStatus[role] = 'failed';
      }
    }

    const completed = findings.filter((item) => item.status === 'completed');
    if (controller.signal.aborted) return timedOut();
    if (completed.length === 0) {
      return {
        status: 'failed',
        error: 'all specialists failed',
        selectedSpecialists,
        findings,
        specialistStatus,
        latencyMs: (options.now ?? Date.now)() - started,
        historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
        provider: model.provider,
        model: model.model,
        ...usage,
      };
    }

    const report = model.provider === 'fake'
      ? synthesizeDeterministic(bounded, completed, currentIds)
      : await synthesizeWithModel(model, bounded, completed, currentIds, controller.signal, usage);
    return {
      status: 'completed',
      report,
      selectedSpecialists,
      findings,
      specialistStatus,
      latencyMs: (options.now ?? Date.now)() - started,
      historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
      provider: model.provider,
      model: model.model,
      ...usage,
    };
  } catch (error) {
    if (controller.signal.aborted) return timedOut();
    const message = error instanceof ContextTooLargeError
      ? 'context_too_large'
      : error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: message,
      selectedSpecialists,
      findings,
      specialistStatus,
      latencyMs: (options.now ?? Date.now)() - started,
      historicalKnowledgeStatus: context.historicalKnowledgeStatus,
      provider: model.provider,
      model: model.model,
      ...usage,
    };
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function synthesizeDeterministic(
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

async function synthesizeWithModel(
  model: RuntimeModel,
  context: RuntimeInvestigationContext,
  findings: SpecialistFinding[],
  currentIds: Set<string>,
  signal: AbortSignal,
  usage: { inputTokens: number; outputTokens: number },
): Promise<RuntimeInvestigationReportInput> {
  const response = await model.invoke({
    system: [
      'COORDINATOR_SYNTHESIS',
      'Return JSON InvestigationReport only. Do not persist chain-of-thought.',
      POLICY,
    ].join('\n'),
    user: JSON.stringify({
      incident: context.incident,
      evidenceIds: [...currentIds],
      findings,
      historicalKnowledge: context.historicalKnowledge ?? null,
    }),
    signal,
  });
  usage.inputTokens += response.inputTokens ?? 0;
  usage.outputTokens += response.outputTokens ?? 0;
  const parsed = investigationReportInputSchema.safeParse(parseModelJson(response.text));
  if (!parsed.success) throw new Error('invalid coordinator synthesis');
  const supporting = parsed.data.supportingEvidenceIds.filter((id) => currentIds.has(id));
  const contradicting = parsed.data.contradictingEvidenceIds.filter((id) => currentIds.has(id));
  if (
    parsed.data.supportingEvidenceIds.some((id) => !currentIds.has(id))
    || parsed.data.contradictingEvidenceIds.some((id) => !currentIds.has(id))
  ) {
    throw new Error('coordinator cited evidence that does not belong to the current incident');
  }
  return {
    ...parsed.data,
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
    recommendation: parsed.data.recommendation.includes('Evidence describes the current incident')
      ? parsed.data.recommendation
      : `${POLICY} ${parsed.data.recommendation}`.slice(0, 2000),
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
