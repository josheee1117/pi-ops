import { isDeepStrictEqual } from 'node:util';
import {
  investigationReportInputSchema,
  investigationDiagnosisSchema,
  diagnosisEvidenceIds,
  deterministicSummary,
  investigationSummarySchema,
  MAX_EVIDENCE_ENRICHMENT_ROUNDS,
  MAX_EVIDENCE_REQUESTS_PER_INVESTIGATION,
  MAX_EVIDENCE_TYPES_PER_SPECIALIST,
  normalizeSpecialistRoles,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  validateRuntimeEvidenceResponse,
  type Evidence,
  type RuntimeInvestigationReportInput,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import { boundInvestigationContext, ContextTooLargeError } from './bound-context.js';
import { ExecutionTimeoutError, withDeadline } from './deadline.js';
import type { RuntimeEvidenceClient } from './evidence-client.js';
import { createFakeRuntimeModel, type RuntimeModel } from './model.js';
import { structuredOutput, IncompleteModelOutputError, incompleteLegacy } from './structured-output.js';
import { CURRENT_EVIDENCE_LIMITS, DIAGNOSIS_CONTRACT, runSpecialist, selectSpecialists } from './specialists.js';

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
    const degraded = completed.find((finding) => finding.summary.startsWith('诊断不完整'));
    const rawReport = degraded && !completed.some((finding) => finding.diagnosis)
      ? { hypothesis: degraded.hypotheses[0]!, recommendation: degraded.summary, confidence: Math.min(0.3, degraded.confidence), supportingEvidenceIds: [], contradictingEvidenceIds: [] }
      : model.provider === 'fake'
        ? synthesizeDeterministic(working, completed, currentIds)
        : await synthesizeWithModel(model, working, completed, currentIds, signal, usage);
    return {
      status: 'completed',
      report: withPlainSummary(rawReport, working),
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
    } catch (error) {
      if (error instanceof IncompleteModelOutputError) {
        usage.inputTokens += error.inputTokens;
        usage.outputTokens += error.outputTokens;
        const legacy = incompleteLegacy(error, {
          hypothesis: `${context.incident.service} 收到 ${context.incident.type}，模型未能完成结构化分析，根因未知。`,
          recommendation: '人工核对当前故障窗口日志、异常栈和对应版本源码，确认影响后再决定处置；验证同一健康目标及关键业务请求。',
        });
        findingsByRole.set(role, { role, hypotheses: [legacy.hypothesis], summary: legacy.recommendation,
          supportingEvidenceIds: [], contradictingEvidenceIds: [], missingEvidence: [], confidence: 0.2, status: 'completed' });
      }
      specialistStatus[role] = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[pi-runtime] specialist ${role} failed: ${message}`);
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
  const collected: Array<{ type: typeof RUNTIME_ALLOWED_EVIDENCE_TYPES[number]; evidence: Evidence }> = [];
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
      evidence: item.evidence as Evidence,
    });
  }
  if (collected.length === 0) return context;
  const merged = mergeCanonicalEvidence(context.evidence, collected.map((item) => item.evidence));
  const enriched: RuntimeInvestigationContext = {
    ...context,
    evidence: merged,
  };
  const bounded = boundInvestigationContext(enriched, options.maxContextBytes);
  const rerunRoles = [...new Set(requests
    .filter((item) => collected.some((result) => result.type === item.type))
    .flatMap((item) => item.requestingRoles))];
  await runRound(rerunRoles, bounded, model, options, signal, specialistStatus, findingsByRole, usage);
  return bounded;
}

function mergeCanonicalEvidence(
  current: RuntimeInvestigationContext['evidence'],
  incoming: Evidence[],
): RuntimeInvestigationContext['evidence'] {
  const merged = [...current];
  for (const evidence of incoming) {
    const existing = merged.find((item) => item.id === evidence.id);
    if (!existing) {
      merged.push(evidence as unknown as RuntimeInvestigationContext['evidence'][number]);
      continue;
    }
    if (!sameCanonicalEvidence(existing, evidence)) {
      throw new Error('evidence identity conflict');
    }
  }
  return merged;
}

function sameCanonicalEvidence(existing: RuntimeInvestigationContext['evidence'][number], incoming: Evidence): boolean {
  const current = existing as Record<string, unknown>;
  const keys: Array<keyof Evidence> = ['id', 'incidentId', 'nodeId', 'source', 'kind', 'collectedAt', 'data'];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    if (!isDeepStrictEqual(current[key], incoming[key])) return false;
  }
  if (incoming.status !== undefined && current.status !== incoming.status) return false;
  return true;
}

function withPlainSummary(report: RuntimeInvestigationReportInput, context: RuntimeInvestigationContext): RuntimeInvestigationReportInput {
  const fallback = deterministicSummary(context.incident, context.summarySeverity);
  const ids = context.evidence.map((item) => item.id);
  const diagnosis = report.diagnosis ?? {
    observations: [],
    candidateCauses: [{ cause: report.hypothesis, supportingEvidenceIds: report.supportingEvidenceIds, contradictingEvidenceIds: report.contradictingEvidenceIds }],
    uncertainties: ['诊断不完整，修复尚未确定。'],
    actions: [{ purpose: 'evidence_collection' as const, target: context.incident.service,
      preconditions: ['确认故障时间和对应部署版本。'], operation: report.recommendation,
      expectedResult: '取得修复依据。', risk: '只读核对，不直接修改服务。', requiresApproval: false, evidenceIds: [] }],
  };
  const needsMitigation = fallback.severity.level === '严重' && !diagnosis.actions.some((item) => item.purpose === 'mitigation');
  const mitigation = {
    purpose: 'mitigation' as const, target: context.incident.service,
    preconditions: ['故障仍持续且确认影响业务。', '负责人批准，已核对备用容量和回滚路径。'],
    operation: '隔离故障流量或暂停已确认的触发任务；若影响扩大，按核对过的路径回滚。',
    expectedResult: '降低失败请求，阻止影响扩大。', risk: '可能中断部分请求，不能自动执行。',
    requiresApproval: true, evidenceIds: ids.slice(0, 20),
  };
  const summary = diagnosis.summary ?? fallback;
  return { ...report, diagnosis: { ...diagnosis,
    summary: { ...summary, severity: fallback.severity,
      recovery: needsMitigation ? [fallback.recovery[0]!, ...summary.recovery.filter((item) => !item.startsWith('止损')).slice(0, 2)] : summary.recovery },
    actions: needsMitigation && ids.length ? [mitigation, ...diagnosis.actions] : diagnosis.actions,
  } };
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
  return investigationReportInputSchema.parse({
    schemaVersion: 1,
    hypothesis: best.hypotheses[0] ?? best.summary,
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
    confidence: best.confidence,
    recommendation,
    diagnosis: best.diagnosis ?? investigationDiagnosisSchema.parse({
      observations: [],
      candidateCauses: findings.flatMap((item) => item.hypotheses.map((cause) => ({
        cause, supportingEvidenceIds: item.supportingEvidenceIds, contradictingEvidenceIds: item.contradictingEvidenceIds,
      }))).slice(0, 5),
      uncertainties: missing.map((type) => `Missing evidence: ${type}`),
      actions: [{
        purpose: 'evidence_collection', target: context.incident.service,
        preconditions: ['修复尚未确定，先由值班人员核对当前证据与故障窗口。'],
        operation: '对照故障窗口日志和当前部署配置。若发现配置与对应版本契约不同，记录差异并提交人工确认；若一致，继续核对调用链。',
        expectedResult: '区分配置差异与调用链故障，取得依据后再确定修复。',
        risk: '只读检查，不修改服务。', requiresApproval: false, evidenceIds: supporting,
      }],
    }),
  });
}

async function synthesizeWithModel(
  model: RuntimeModel,
  context: RuntimeInvestigationContext,
  findings: SpecialistFinding[],
  currentIds: Set<string>,
  signal: AbortSignal,
  usage: { inputTokens: number; outputTokens: number },
): Promise<RuntimeInvestigationReportInput> {
  let response;
  try {
    response = await structuredOutput(model, {
    system: [
      'COORDINATOR_SYNTHESIS',
      'Return ONLY one JSON object. No markdown. No extra text.',
      'Required keys: hypothesis, supportingEvidenceIds, contradictingEvidenceIds, confidence, recommendation, diagnosis.',
      'supportingEvidenceIds and contradictingEvidenceIds must be strings from the provided evidenceIds.',
      'confidence is 0 to 1. Do not persist chain-of-thought.',
      'Write hypothesis and recommendation in concise Simplified Chinese for the on-call engineer. Keep JSON keys unchanged. Evidence IDs in JSON arrays stay unchanged.',
      DIAGNOSIS_CONTRACT,
      'Do not repeat internal policy text in the recommendation. Do not claim that a running container proves JVM health or that an exception message proves an external dependency failure.',
      POLICY,
      CURRENT_EVIDENCE_LIMITS,
    ].join('\n'),
    user: JSON.stringify({
      incident: context.incident,
      summarySeverity: deterministicSummary(context.incident, context.summarySeverity).severity,
      evidenceIds: [...currentIds],
      evidence: context.evidence,
      findings,
      historicalKnowledge: context.historicalKnowledge ?? null,
    }),
    signal,
    }, (value) => {
      const parsed = investigationReportInputSchema.extend({ diagnosis: investigationDiagnosisSchema.extend({ summary: investigationSummarySchema }) }).safeParse(normalizeReportPayload(value));
      if (!parsed.success) throw new Error(`invalid coordinator synthesis: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      if (deterministicSummary(context.incident, context.summarySeverity).severity.level === '严重'
        && parsed.data.diagnosis.actions.length === 8 && !parsed.data.diagnosis.actions.some((item) => item.purpose === 'mitigation')) {
        throw new Error('invalid coordinator synthesis: unavailable service requires room for mitigation');
      }
      return parsed.data;
    });
  } catch (error) {
    if (!(error instanceof IncompleteModelOutputError)) throw error;
    usage.inputTokens += error.inputTokens;
    usage.outputTokens += error.outputTokens;
    const best = [...findings].sort((a, b) => b.confidence - a.confidence)[0]!;
    return { ...incompleteLegacy(error, { hypothesis: best.hypotheses[0] ?? best.summary, recommendation: best.summary }),
      supportingEvidenceIds: best.supportingEvidenceIds, contradictingEvidenceIds: best.contradictingEvidenceIds,
      confidence: Math.min(best.confidence, 0.3) };
  }
  usage.inputTokens += response.inputTokens;
  usage.outputTokens += response.outputTokens;
  const parsed = { data: response.value };
  const supporting = parsed.data.supportingEvidenceIds.filter((id) => currentIds.has(id));
  const contradicting = parsed.data.contradictingEvidenceIds.filter((id) => currentIds.has(id));
  if (
    parsed.data.supportingEvidenceIds.some((id) => !currentIds.has(id))
    || parsed.data.contradictingEvidenceIds.some((id) => !currentIds.has(id))
    || diagnosisEvidenceIds(parsed.data.diagnosis).some((id) => !currentIds.has(id))
  ) {
    throw new Error('coordinator cited evidence that does not belong to the current incident');
  }
  return {
    ...parsed.data,
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
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

function normalizeReportPayload(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = { ...(data as Record<string, unknown>) };
  if (record.hypothesis && typeof record.hypothesis !== 'string') {
    const hypothesis = record.hypothesis as Record<string, unknown>;
    record.hypothesis = typeof hypothesis.statement === 'string'
      ? hypothesis.statement
      : typeof hypothesis.text === 'string'
        ? hypothesis.text
        : JSON.stringify(record.hypothesis);
  }
  if (typeof record.recommendation !== 'string' && record.recommendation) {
    record.recommendation = JSON.stringify(record.recommendation);
  }
  if (typeof record.confidence === 'string') {
    const parsed = Number(record.confidence);
    if (Number.isFinite(parsed)) record.confidence = parsed;
  }
  record.supportingEvidenceIds = asIdList(record.supportingEvidenceIds);
  record.contradictingEvidenceIds = asIdList(record.contradictingEvidenceIds);
  record.diagnosis = liftFlatSummary(record.diagnosis);
  return record;
}

const SUMMARY_KEYS = ['scene', 'whatHappened', 'severity', 'recovery'] as const;

function liftFlatSummary(diagnosis: unknown): unknown {
  if (!diagnosis || typeof diagnosis !== 'object' || Array.isArray(diagnosis)) return diagnosis;
  const record = { ...(diagnosis as Record<string, unknown>) };
  if (record.summary !== undefined || !SUMMARY_KEYS.every((key) => key in record)) return record;
  const summary: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) {
    summary[key] = record[key];
    delete record[key];
  }
  record.summary = summary;
  return record;
}

function asIdList(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        return [(item as { id: string }).id];
      }
      return [];
    });
  }
  if (typeof value === 'string') {
    return value.split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
  }
  return value;
}
