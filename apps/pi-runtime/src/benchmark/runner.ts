import { investigate, type CoordinatorOutcome } from '../coordinator.js';
import type { RuntimeModel } from '../model.js';
import type { RuntimeInvestigationContext, RuntimeEvidenceResponse } from '@pi-ops/protocol';
import { projectCase, fixedEvidenceClient, renderMessage } from './agent-chain.js';
import { CPU_GOLDEN_CASES, buildBenchmarkContext, findCase, type BenchmarkCase } from './fixtures.js';
import { evaluateCase, evaluateMessage, type BenchmarkEvaluation, type MessageEvaluation } from './evaluator.js';

export interface ThinkingReport {
  requested: string;
  /** Level the provider adapter actually applied, when it can report one. */
  effective: string | null;
  status: 'honored' | 'clamped' | 'unsupported' | 'not_applicable';
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface ModelCall {
  role: string;
  status: 'ok' | 'error';
  chars: number;
  /** Truncated raw assistant text, for post-hoc review of a failed specialist. */
  text?: string;
  error?: string;
  inputChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
  model?: string;
}

export interface CaseResult {
  caseId: string;
  description: string;
  provider: string;
  model: string;
  mode: 'fake' | 'live';
  thinking: ThinkingReport;
  status: 'completed' | 'failed';
  error?: string;
  latencyMs: number;
  tokenUsage: TokenUsage | null;
  usageNote?: string;
  selectedSpecialists: string[];
  specialistStatus: Record<string, 'completed' | 'failed' | 'skipped'>;
  /**
   * Per-invocation model output. A specialist can fail AFTER invoke resolves
   * (JSON/schema validation), so the raw text is what explains a failed case.
   */
  modelCalls: ModelCall[];
  evidenceIds: string[];
  evaluation: BenchmarkEvaluation | null;
  modelContext?: RuntimeInvestigationContext;
  supplementalResponses?: RuntimeEvidenceResponse[];
  message?: { content: string; bytes: number; fetchCalls: number };
  messageEvaluation?: MessageEvaluation;
  investigation: {
    report?: CoordinatorOutcome['report'];
    findings: CoordinatorOutcome['findings'];
  };
}

export interface RunOptions {
  cases?: BenchmarkCase[];
  model: RuntimeModel;
  mode: 'fake' | 'live';
  caseIds?: string[];
  thinkingLevel: string;
  /** Output directory. When omitted, results are returned but not written. */
  experimentLabel?: string;
  tokenBudget?: number;
  maxContextBytes?: number;
  executionTimeoutMs?: number;
}

export function resolveCases(caseIds?: string[]): BenchmarkCase[] {
  if (!caseIds || caseIds.length === 0) return CPU_GOLDEN_CASES;
  const resolved: BenchmarkCase[] = [];
  for (const id of caseIds) {
    const found = findCase(id)
      ?? CPU_GOLDEN_CASES.find((item) => item.id.includes(id));
    if (!found) {
      throw new Error(`unknown benchmark case: ${id} (available: ${CPU_GOLDEN_CASES.map((item) => item.id).join(', ')})`);
    }
    if (!resolved.includes(found)) resolved.push(found);
  }
  return resolved;
}

/**
 * The Pi SDK clamps an unsupported level to what the model supports. We report
 * that as `clamped` instead of pretending the requested level was honored.
 * The fake model has no thinking budget, so it is `not_applicable`.
 */
export function describeThinking(
  requested: string,
  effective: string | undefined,
  mode: 'fake' | 'live',
): ThinkingReport {
  if (mode === 'fake') return { requested, effective: null, status: 'not_applicable' };
  if (effective === undefined || effective === null) return { requested, effective: null, status: 'unsupported' };
  if (effective === requested) return { requested, effective, status: 'honored' };
  return { requested, effective, status: 'clamped' };
}

export function usageOrNull(
  outcome: CoordinatorOutcome,
  mode: 'fake' | 'live',
): { usage: TokenUsage | null; note?: string } {
  const input = outcome.inputTokens ?? 0;
  const output = outcome.outputTokens ?? 0;
  if (mode === 'fake') {
    return { usage: null, note: 'deterministic fake model: token usage is not meaningful' };
  }
  if (!Number.isFinite(input) && !Number.isFinite(output)) {
    return { usage: null, note: 'provider does not expose usage' };
  }
  return { usage: { input, output, total: input + output } };
}

/** Generous cap only to avoid a pathological response; requirement is to keep the full output for review. */
const MAX_CALL_TEXT_CHARS = 20_000;

function roleOf(system: string): string {
  return /SPECIALIST_ROLE=([a-z_]+)/.exec(system)?.[1]
    ?? (system.includes('COORDINATOR_SYNTHESIS') ? 'coordinator' : 'unknown');
}

/**
 * Wrap a model so a failed specialist keeps its reason.
 * `investigate()` deliberately isolates a failing specialist, which is right for
 * production but leaves the benchmark unable to explain a failed case. This adds
 * no production surface: the benchmark simply observes the model it injects.
 */
function withCallCapture(model: RuntimeModel, calls: ModelCall[]): RuntimeModel {
  return {
    get provider() {
      return model.provider;
    },
    get model() {
      return model.model;
    },
    get networkCalls() {
      return model.networkCalls;
    },
    get effectiveThinkingLevel() {
      return model.effectiveThinkingLevel;
    },
    async invoke(request) {
      const role = roleOf(request.system);
      try {
        const response = await model.invoke(request);
        calls.push({
          role,
          status: 'ok',
          chars: response.text.length,
          inputChars: request.system.length + request.user.length,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          provider: response.provider ?? model.provider,
          model: response.model ?? model.model,
          text: response.text.length > MAX_CALL_TEXT_CHARS
            ? `${response.text.slice(0, MAX_CALL_TEXT_CHARS)}…[truncated]`
            : response.text,
        });
        return response;
      } catch (error) {
        calls.push({ role, status: 'error', chars: 0, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

export async function runCase(
  benchmarkCase: BenchmarkCase,
  options: Omit<RunOptions, 'cases' | 'caseIds'>,
): Promise<CaseResult> {
  const { model, mode, thinkingLevel } = options;
  const context = benchmarkCase.rawIncident ? await projectCase(benchmarkCase) : buildBenchmarkContext(benchmarkCase);
  const supplementalResponses: RuntimeEvidenceResponse[] = [];
  const modelCalls: ModelCall[] = [];
  const started = Date.now();
  let outcome: CoordinatorOutcome;
  try {
    outcome = await investigate(context, {
      model: withCallCapture(model, modelCalls),
      ...(options.maxContextBytes ? { maxContextBytes: options.maxContextBytes } : {}),
      ...(options.executionTimeoutMs ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
      ...(benchmarkCase.rawIncident ? {
        evidenceClient: fixedEvidenceClient(benchmarkCase, supplementalResponses),
        runtimeRequestId: `request-${benchmarkCase.id}`, runtimeTaskId: `task-${benchmarkCase.id}`, sessionId: benchmarkCase.id,
      } : {}),
    });
  } catch (error) {
    return {
      caseId: benchmarkCase.id,
      description: benchmarkCase.description,
      provider: model.provider,
      model: model.model,
      mode,
      thinking: describeThinking(thinkingLevel, model.effectiveThinkingLevel, mode),
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      tokenUsage: null,
      selectedSpecialists: [],
      specialistStatus: {},
      modelCalls,
      evidenceIds: benchmarkCase.evidence.map((item) => item.id),
      evaluation: null,
      investigation: { findings: [] },
    };
  }
  const observedUsage = modelCalls.every((call) => call.status === 'ok' && call.inputTokens !== undefined && call.outputTokens !== undefined)
    ? modelCalls.reduce((sum, call) => ({ input: sum.input + (call.inputTokens ?? 0), output: sum.output + (call.outputTokens ?? 0), total: sum.total + (call.inputTokens ?? 0) + (call.outputTokens ?? 0) }), { input: 0, output: 0, total: 0 })
    : null;
  const { usage, note } = mode === 'live'
    ? { usage: observedUsage, note: observedUsage ? undefined : 'At least one invocation omitted usage or failed; totals are incomplete. See modelCalls.' }
    : usageOrNull(outcome, mode);
  const supplemental = supplementalResponses.flatMap((response) => response.results.flatMap((result) => result.status === 'collected' ? [{ ...result.evidence, data: result.evidence.data, status: 'succeeded' as const }] : []));
  const visibleIds = new Set(context.evidence.map((item) => item.id));
  const visibleEvidence = [...benchmarkCase.evidence.filter((item) => visibleIds.has(item.id)), ...supplemental];
  const message = benchmarkCase.rawIncident && outcome.report
    ? await renderMessage(benchmarkCase, outcome.report, visibleEvidence)
    : undefined;
  const messageEvaluation = message && benchmarkCase.messageOracle
    ? evaluateMessage(benchmarkCase.messageOracle, outcome.report, outcome.findings, visibleEvidence, message.content)
    : undefined;
  // A run that never produced a report is a failed case, not a scored one:
  // scoring it would let "no diagnosis" masquerade as a partial pass.
  const evaluation = outcome.status === 'completed' && outcome.report
    ? evaluateCase({ ...benchmarkCase, evidence: visibleEvidence }, { report: outcome.report, findings: outcome.findings })
    : null;
  return {
    caseId: benchmarkCase.id,
    description: benchmarkCase.description,
    provider: outcome.provider,
    model: outcome.model,
    mode,
    thinking: describeThinking(thinkingLevel, model.effectiveThinkingLevel, mode),
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    latencyMs: outcome.latencyMs,
    tokenUsage: usage,
    ...(note ? { usageNote: note } : {}),
    selectedSpecialists: outcome.selectedSpecialists,
    specialistStatus: outcome.specialistStatus,
    modelCalls,
    evidenceIds: benchmarkCase.evidence.map((item) => item.id),
    evaluation,
    ...(benchmarkCase.rawIncident ? { modelContext: context, supplementalResponses } : {}),
    ...(message ? { message } : {}),
    ...(messageEvaluation ? { messageEvaluation } : {}),
    investigation: {
      ...(outcome.report ? { report: outcome.report } : {}),
      findings: outcome.findings,
    },
  };
}

export function estimateCaseTokens(benchmarkCase: BenchmarkCase): number {
  // Reserve covers these cases' two specialists, one rerun each and synthesis, including long Chinese actions.
  return benchmarkCase.rawIncident ? 100_000 : 80_000;
}

export async function runBenchmark(options: RunOptions): Promise<CaseResult[]> {
  const cases = options.cases ?? resolveCases(options.caseIds);
  const results: CaseResult[] = [];
  for (const benchmarkCase of cases) {
    const spent = results.reduce((sum, result) => sum + result.modelCalls.reduce((subtotal, call) => subtotal + (call.inputTokens ?? 0) + (call.outputTokens ?? 0), 0), 0);
    if (options.tokenBudget !== undefined && spent + estimateCaseTokens(benchmarkCase) > options.tokenBudget) {
      throw new Error(`token budget would be exceeded before ${benchmarkCase.id}: spent=${spent} reserve=${estimateCaseTokens(benchmarkCase)} budget=${options.tokenBudget}`);
    }
    results.push(await runCase(benchmarkCase, {
      model: options.model,
      mode: options.mode,
      thinkingLevel: options.thinkingLevel,
      ...(options.maxContextBytes ? { maxContextBytes: options.maxContextBytes } : {}),
      ...(options.executionTimeoutMs ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
      ...(options.experimentLabel ? { experimentLabel: options.experimentLabel } : {}),
    }));
  }
  return results;
}
