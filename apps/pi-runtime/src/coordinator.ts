import {
  investigationReportInputSchema,
  MAX_EVIDENCE_ENRICHMENT_ROUNDS,
  MAX_EVIDENCE_REQUESTS_PER_INVESTIGATION,
  MAX_EVIDENCE_TYPES_PER_SPECIALIST,
  normalizeSpecialistRoles,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  validateRuntimeEvidenceResponse,
  type RuntimeInvestigationReportInput,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import { boundInvestigationContext, ContextTooLargeError } from './bound-context.js';
import { ExecutionTimeoutError, withDeadline } from './deadline.js';
import type { RuntimeEvidenceClient } from './evidence-client.js';
import { createFakeRuntimeModel, parseModelJson, type RuntimeModel } from './model.js';
import { runSpecialist, selectSpecialists } from './specialists.js';

export interface CoordinatorOptions {
  model?: RuntimeModel;
  failRoles?: readonly SpecialistRole[];
  failCoordinator?: boolean;
  maxContextBytes?: number;
  executionTimeoutMs?: number;
  now?: () => number;
  evidenceClient?: RuntimeEvidenceClient;
  runtimeRequestId?: string;
  runtimeTaskId?: string;
  sessionId?: string;
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
  'Absence of evidence is not evidence of absence.',
].join(' ');

export async function investigate(
  context: RuntimeInvestigationContext,
  options: CoordinatorOptions = {},
): Promise<CoordinatorOutcome> {
  const started = (options.now ?? Date.now)();
  const model = options.model ?? createFakeRuntimeModel();
  const base = (): Omit<CoordinatorOutcome, 'status' | 'latencyMs'> => ({
    selectedSpecialists: [],
    findings: [],
    specialistStatus: {},
    historicalKnowledgeStatus: context.historicalKnowledgeStatus,
    provider: model.provider,
    model: model.model,
    inputTokens: 0,
    outputTokens: 0,
  });

  const run = async (signal: AbortSignal): Promise<CoordinatorOutcome> => {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'> = {};
    const findingsByRole = new Map<SpecialistRole, SpecialistFinding>();
    const bounded = boundInvestigationContext(context, options.maxContextBytes);
    const selectedSpecialists = selectSpecialists(bounded);
    let working: RuntimeInvestigationContext = {
      ...bounded,
      evidence: [...bounded.evidence],
    };

    if (options.failCoordinator) {
      return {
        status: 'failed',
        error: 'coordinator failed',
        selectedSpecialists,
        findings: [],
        specialistStatus,
        latencyMs: (options.now ?? Date.now)() - started,
        historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
        provider: model.provider,
        model: model.model,
        ...usage,
      };
    }

    await runRound(selectedSpecialists, working, model, options, signal, specialistStatus, findingsByRole, usage);
    working = await enrichOnce(working, selectedSpecialists, findingsByRole, options, signal, specialistStatus, usage, model);

    const completed = [...findingsByRole.values()].filter((item) => item.status === 'completed');
    if (signal.aborted) throw new ExecutionTimeoutError();
    if (completed.length === 0) {
      return {
        status: 'failed',
        error: 'all specialists failed',
        selectedSpecialists,
        findings: completed,
        specialistStatus,
        latencyMs: (options.now ?? Date.now)() - started,
        historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
        provider: model.provider,
        model: model.model,
        ...usage,
      };
    }

    const currentIds = new Set(working.evidence.map((item) => item.id));
    const report = model.provider === 'fake'
      ? synthesizeDeterministic(working, completed, currentIds)
      : await synthesizeWithModel(model, working, completed, currentIds, signal, usage);
    return {
      status: 'completed',
      report,
      selectedSpecialists,
      findings: completed,
      specialistStatus,
      latencyMs: (options.now ?? Date.now)() - started,
      historicalKnowledgeStatus: bounded.historicalKnowledgeStatus,
      provider: model.provider,
      model: model.model,
      ...usage,
    };
  };

  try {
    if (options.executionTimeoutMs) {
      return await withDeadline(options.executionTimeoutMs, run);
    }
    return await run(new AbortController().signal);
  } catch (error) {
    if (error instanceof ExecutionTimeoutError || (error instanceof Error && error.message === 'execution timeout')) {
      return { ...base(), status: 'failed', error: 'execution timeout', latencyMs: (options.now ?? Date.now)() - started };
    }
    const message = error instanceof ContextTooLargeError
      ? 'context_too_large'
      : error instanceof Error ? error.message : String(error);
    return { ...base(), status: 'failed', error: message, latencyMs: (options.now ?? Date.now)() - started };
  }
}

async function runRound(
  roles: SpecialistRole[],
  context: RuntimeInvestigationContext,
  model: RuntimeModel,
  options: CoordinatorOptions,
  signal: AbortSignal,
  specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'>,
  findingsByRole: Map<SpecialistRole, SpecialistFinding>,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  for (const role of roles) {
    if (signal.aborted) throw new ExecutionTimeoutError();
    if (options.failRoles?.includes(role)) {
      specialistStatus[role] = 'failed';
      continue;
    }
    try {
      const result = await runSpecialist(role, context, model, signal);
      usage.inputTokens += result.inputTokens;
      usage.outputTokens += result.outputTokens;
      findingsByRole.set(role, result.finding);
      specialistStatus[role] = 'completed';
    } catch {
      specialistStatus[role] = 'failed';
    }
  }
}

async function enrichOnce(
  context: RuntimeInvestigationContext,
  selected: SpecialistRole[],
  findingsByRole: Map<SpecialistRole, SpecialistFinding>,
  options: CoordinatorOptions,
  signal: AbortSignal,
  specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'>,
  usage: { inputTokens: number; outputTokens: number },
  model: RuntimeModel,
): Promise<RuntimeInvestigationContext> {
  if (!options.evidenceClient || MAX_EVIDENCE_ENRICHMENT_ROUNDS < 1) return context;
  if (!options.runtimeRequestId || !options.runtimeTaskId || !options.sessionId) return context;
  const sessionPrefix = options.sessionId ? `inv-${options.sessionId}-evidence-` : '';
  const existingKinds = new Set(
    context.evidence
      .filter((item) => sessionPrefix !== '' && item.id.startsWith(sessionPrefix))
      .map((item) => item.kind),
  );
  const byType = new Map<typeof RUNTIME_ALLOWED_EVIDENCE_TYPES[number], Set<SpecialistRole>>();
  for (const role of selected) {
    const finding = findingsByRole.get(role);
    if (!finding) continue;
    let taken = 0;
    for (const type of finding.missingEvidence) {
      if (!(RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(type)) continue;
      if (existingKinds.has(type)) continue;
      const key = type as typeof RUNTIME_ALLOWED_EVIDENCE_TYPES[number];
      const roles = byType.get(key) ?? new Set<SpecialistRole>();
      if (roles.has(role)) continue;
      if (taken >= MAX_EVIDENCE_TYPES_PER_SPECIALIST) continue;
      if (!byType.has(key) && byType.size >= MAX_EVIDENCE_REQUESTS_PER_INVESTIGATION) continue;
      taken += 1;
      roles.add(role);
      byType.set(key, roles);
    }
  }
  const requests = [...byType.entries()].map(([type, roles]) => ({
    requestId: `ereq-${options.sessionId}-${type}`,
    type,
    requestingRoles: normalizeSpecialistRoles([...roles]),
  }));
  if (requests.length === 0) return context;
  let raw: unknown;
  try {
    raw = await options.evidenceClient.request({
      runtimeRequestId: options.runtimeRequestId,
      runtimeTaskId: options.runtimeTaskId,
      sessionId: options.sessionId,
      requests,
    });
  } catch {
    return context;
  }
  const parsed = validateRuntimeEvidenceResponse(raw);
  if (!parsed.success) return context;
  if (parsed.value.runtimeRequestId !== options.runtimeRequestId) return context;
  const requestedTypeById = new Map(requests.map((item) => [item.requestId, item.type]));
  const answered = new Set<string>();
  const collected: Array<{ type: typeof RUNTIME_ALLOWED_EVIDENCE_TYPES[number]; evidence: { id: string; kind: string } }> = [];
  for (const item of parsed.value.results) {
    const requestedType = requestedTypeById.get(item.requestId);
    if (requestedType === undefined) continue;
    if (answered.has(item.requestId)) continue;
    answered.add(item.requestId);
    if (item.status !== 'collected') continue;
    if (item.type !== requestedType) continue;
    if (item.evidenceId !== item.evidence.id) continue;
    if (item.evidence.kind !== requestedType) continue;
    if (item.evidence.incidentId !== context.incident.id) continue;
    collected.push({
      type: requestedType,
      evidence: { id: item.evidence.id, kind: item.evidence.kind },
    });
  }
  if (collected.length === 0) return context;
  const enriched: RuntimeInvestigationContext = {
    ...context,
    evidence: [...context.evidence, ...collected.map((item) => item.evidence)],
  };
  const rerunRoles = [...new Set(requests
    .filter((item) => collected.some((result) => result.type === item.type))
    .flatMap((item) => item.requestingRoles))];
  await runRound(rerunRoles, enriched, model, options, signal, specialistStatus, findingsByRole, usage);
  return enriched;
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
  const missing = unique(findings.flatMap((item) => item.missingEvidence));
  const advisory = advisoryHistory(context);
  const gaps = missing.length > 0 ? ` Missing evidence remains: ${missing.join(', ')}.` : '';
  const recommendation = advisory
    ? `${best.summary}.${gaps} Advisory history (not Evidence): ${advisory}`
    : `${best.summary}.${gaps}`;
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
