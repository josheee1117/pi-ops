import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { RuntimeModel } from '../model.js';
import type { BenchmarkCase } from './fixtures.js';
import { runCase, type CaseResult } from './runner.js';
import { projectCase, withoutSourceSnippetBodies } from './agent-chain.js';
import type { RepairKind } from './repair-classification.js';
import { criteriaFor, HANDLER_ITEMS, type ClosedLoopCriteria, type SourceFixture } from './closed-loop-cases.js';
import { openCaseAgentServer, type StoredEvidence } from './closed-loop-server.js';
import { runHandler, runJudge, type HandlerResult, type JudgeItem, type JudgeResult, type ToolCallLog } from './closed-loop-agent.js';

export type ClosedLoopVerdict = 'closed' | 'partial' | 'open';

export type GapKind =
  | 'detail_fetch_failed' | 'missing_source' | 'diagnosis_wrong'
  | 'message_insufficient' | 'handler_no_answer' | 'handler_reasoning'
  | 'diagnosis_unavailable';

export interface ClosedLoopCaseResult {
  caseId: string;
  description: string;
  provenance: string;
  mode: 'fake' | 'live';
  provider: string;
  model: string;
  diagnosis: {
    status: string;
    provider: string;
    model: string;
    latencyMs: number;
    tokens: number;
    reportHardPass: boolean;
    messageHardPass: boolean;
    degraded: boolean;
    repairKind?: RepairKind;
    error?: string;
    report?: unknown;
    modelCalls?: Array<{ role: string; status: string; stopReason?: string; inputTokens?: number; outputTokens?: number; text?: string }>;
  };
  incidentId?: string;
  message?: { content: string; bytes: number };
  detail?: { bytes: number; evidenceCount: number; markdown: string };
  sources: Array<SourceFixture & { sha256: string | null }>;
  handler: {
    provider: string;
    model: string;
    status: HandlerResult['status'];
    error?: string;
    turns: number;
    calls: ToolCallLog[];
    answer?: HandlerResult['answer'];
    texts?: HandlerResult['texts'];
    inputTokens: number;
    outputTokens: number;
  };
  judge?: {
    provider: string;
    model: string;
    items: JudgeItem[];
    notes: string;
    inputTokens: number;
    outputTokens: number;
    error?: string;
  };
  verdict: ClosedLoopVerdict;
  failedItems: string[];
  gaps: GapKind[];
  primaryGap: GapKind | null;
  tokens: number;
  latencyMs: number;
  error?: string;
}

export interface ClosedLoopOptions {
  repoRoot: string;
  diagnosisModel: RuntimeModel;
  handlerModel: RuntimeModel;
  judgeModel: RuntimeModel;
  mode: 'fake' | 'live';
  diagnosisThinking: string;
  beforeCall?: (requestChars: number) => void;
}

export function deriveVerdict(criteria: ClosedLoopCriteria, items: JudgeItem[], handlerStatus: HandlerResult['status']): ClosedLoopVerdict {
  if (handlerStatus !== 'answered') return 'open';
  const pass = (id: string) => items.find((item) => item.id === id)?.pass === true;
  if (criteria.criticalItems.some((id) => !pass(id))) return 'open';
  return HANDLER_ITEMS.every((id) => pass(id)) ? 'closed' : 'partial';
}

export function deriveGaps(input: {
  verdict: ClosedLoopVerdict;
  items: JudgeItem[];
  handler: HandlerResult;
  criteria: ClosedLoopCriteria;
  detailFailed: boolean;
  diagnosisUnavailable: boolean;
}): GapKind[] {
  const gaps: GapKind[] = [];
  if (input.diagnosisUnavailable) return ['diagnosis_unavailable'];
  if (input.verdict === 'closed') return gaps;
  const failed = (id: string) => input.items.find((item) => item.id === id)?.pass === false;
  if (input.detailFailed) gaps.push('detail_fetch_failed');
  if (!input.criteria.sources.length && (failed('root_cause') || failed('repair'))) gaps.push('missing_source');
  if (failed('diagnosis_truth')) gaps.push('diagnosis_wrong');
  if (failed('info_sufficiency')) gaps.push('message_insufficient');
  if (input.handler.status !== 'answered') gaps.push('handler_no_answer');
  if (!gaps.length) gaps.push('handler_reasoning');
  return gaps;
}

const GAP_PRIORITY: GapKind[] = [
  'detail_fetch_failed', 'missing_source', 'diagnosis_wrong', 'message_insufficient',
  'diagnosis_unavailable', 'handler_no_answer', 'handler_reasoning',
];

export function primaryGap(gaps: GapKind[]): GapKind | null {
  return GAP_PRIORITY.find((item) => gaps.includes(item)) ?? null;
}

export function diagnosisExcerpt(report: unknown): string {
  const root = (report ?? {}) as Record<string, unknown>;
  const diagnosis = (root['diagnosis'] ?? {}) as Record<string, unknown>;
  const value = {
    hypothesis: root['hypothesis'],
    recommendation: root['recommendation'],
    confidence: root['confidence'],
    summary: diagnosis['summary'],
    candidateCauses: diagnosis['candidateCauses'],
    uncertainties: diagnosis['uncertainties'],
    actions: diagnosis['actions'],
  };
  const text = JSON.stringify(value, null, 2);
  return text.length > 8000 ? `${text.slice(0, 8000)}\n…[truncated]` : text;
}

function numbered(text: string): string {
  return text.split('\n').slice(0, 2000).map((line, index) => `${index + 1}: ${line}`).join('\n');
}

export function loadSourceFixtures(repoRoot: string, criteria: ClosedLoopCriteria): Array<{ path: string; content: string }> {
  return criteria.sources.flatMap((item) => {
    try {
      return [{ path: item.path, content: readFileSync(resolve(repoRoot, item.path), 'utf8').slice(0, 60_000) }];
    } catch {
      return [];
    }
  });
}

function sourceDigest(repoRoot: string, sources: SourceFixture[]): ClosedLoopCaseResult['sources'] {
  return sources.map((item) => {
    try {
      return { ...item, sha256: createHashOf(readFileSync(resolve(repoRoot, item.path))) };
    } catch {
      return { ...item, sha256: null };
    }
  });
}

function createHashOf(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function measurableEvidence(benchmarkCase: BenchmarkCase, diagnosis: CaseResult): StoredEvidence[] {
  const supplemental = (diagnosis.supplementalResponses ?? []).flatMap((response) => response.results.flatMap((result) => (
    result.status === 'collected' ? [result.evidence] : []
  )));
  const seen = new Set<string>();
  const result: StoredEvidence[] = [];
  for (const item of [...benchmarkCase.evidence, ...supplemental]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({
      id: item.id, incidentId: item.incidentId, nodeId: item.nodeId, source: item.source,
      kind: item.kind, collectedAt: item.collectedAt, status: 'succeeded', data: item.data,
    });
  }
  return result;
}

export async function runClosedLoopCase(benchmarkCase: BenchmarkCase, options: ClosedLoopOptions): Promise<ClosedLoopCaseResult> {
  const criteria = criteriaFor(benchmarkCase.id);
  const repoRoot = resolve(options.repoRoot);
  const started = Date.now();
  const diagnosis = await runCase(benchmarkCase, {
    model: options.diagnosisModel, mode: options.mode, thinkingLevel: options.diagnosisThinking,
    maxContextBytes: 65_536, executionTimeoutMs: 300_000,
  });
  const report = diagnosis.investigation.report;
  const reportTokens = (diagnosis.modelCalls ?? []).reduce((sum, call) => sum + (call.inputTokens ?? 0) + (call.outputTokens ?? 0), 0);
  const base = {
    caseId: benchmarkCase.id, description: benchmarkCase.description, provenance: benchmarkCase.provenance ?? '',
    mode: options.mode, provider: diagnosis.provider, model: diagnosis.model,
    sources: sourceDigest(options.repoRoot, criteria.sources),
    tokens: reportTokens, latencyMs: 0,
  };
  const diagnosisSummary = {
    status: diagnosis.status, provider: diagnosis.provider, model: diagnosis.model,
    latencyMs: diagnosis.latencyMs, tokens: reportTokens,
    reportHardPass: diagnosis.evaluation?.hardPass === true,
    messageHardPass: diagnosis.messageEvaluation?.hardPass === true,
    degraded: diagnosis.evaluation?.degraded === true || diagnosis.messageEvaluation?.degraded === true,
    repairKind: diagnosis.repairKind,
    ...(diagnosis.error ? { error: diagnosis.error } : {}),
    ...(report ? { report } : {}),
    modelCalls: (diagnosis.modelCalls ?? []).map((call) => ({
      role: call.role, status: call.status, ...(call.stopReason ? { stopReason: call.stopReason } : {}),
      inputTokens: call.inputTokens, outputTokens: call.outputTokens, ...(call.text ? { text: call.text } : {}),
    })),
  };
  if (diagnosis.status !== 'completed' || !report) {
    return {
      ...base, diagnosis: diagnosisSummary, verdict: 'open', failedItems: [...HANDLER_ITEMS],
      gaps: ['diagnosis_unavailable'], primaryGap: 'diagnosis_unavailable', latencyMs: Date.now() - started,
      error: diagnosis.error ?? '诊断未生成结构化报告',
      handler: { provider: options.handlerModel.provider, model: options.handlerModel.model, status: 'failed', turns: 0, calls: [], texts: [], inputTokens: 0, outputTokens: 0 },
    };
  }

  const sourceEvidence = (await projectCase(benchmarkCase)).evidence;
  const sourceBodies = loadSourceFixtures(repoRoot, criteria).map((item) => ({
    kind: 'source.snippet', data: { text: item.content },
  }));
  const agent = await openCaseAgentServer(benchmarkCase, report, measurableEvidence(benchmarkCase, diagnosis));
  try {
    const handlerTools = {
      detailUrl: agent.detailUrl,
      sourcePaths: criteria.sources.map((item) => item.path),
      async fetchDetails(url: string) {
        try {
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${agent.operatorToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          const body = await response.text();
          return { ok: response.status === 200, body: response.status === 200 ? body : `HTTP ${response.status}: ${body.slice(0, 500)}` };
        } catch (error) {
          return { ok: false, body: `请求失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
      async readSource(path: string) {
        if (!criteria.sources.some((item) => item.path === path)) {
          return { ok: false, body: `路径不在允许列表。${criteria.missingSources ?? '只能用提供的源码夹具。'}` };
        }
        const absolute = resolve(repoRoot, path);
        if (!absolute.startsWith(repoRoot + sep)) return { ok: false, body: '路径越界' };
        try {
          return { ok: true, body: numbered(readFileSync(absolute, 'utf8')) };
        } catch (error) {
          return { ok: false, body: `读取失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
    };
    const handler = await runHandler({
      model: options.handlerModel, message: agent.message, criteria, tools: handlerTools,
      ...(options.beforeCall ? { beforeCall: options.beforeCall } : {}),
    });
    let judge: JudgeResult | undefined;
    let judgeError: string | undefined;
    if (handler.status === 'answered') {
      try {
        judge = await runJudge({
          model: options.judgeModel, message: agent.message, detailMarkdown: agent.detailMarkdown,
          criteria, diagnosisExcerpt: diagnosisExcerpt(report), handler,
          sources: loadSourceFixtures(repoRoot, criteria),
          ...(options.beforeCall ? { beforeCall: options.beforeCall } : {}),
        });
      } catch (error) {
        judgeError = error instanceof Error ? error.message : String(error);
      }
    }
    const items = judge?.items ?? [];
    const verdict = judge ? deriveVerdict(criteria, items, handler.status) : 'open';
    const detailFailed = agent.detailBytes === 0 || handler.calls.some((call) => call.tool === 'fetch_details' && !call.ok);
    const gaps = deriveGaps({ verdict, items, handler, criteria, detailFailed, diagnosisUnavailable: false });
    return withoutSourceSnippetBodies({
      ...base,
      diagnosis: diagnosisSummary,
      incidentId: agent.incidentId,
      message: { content: agent.message, bytes: Buffer.byteLength(agent.message) },
      detail: { bytes: agent.detailBytes, evidenceCount: agent.evidenceCount, markdown: agent.detailMarkdown },
      handler: {
        provider: options.handlerModel.provider, model: options.handlerModel.model,
        status: handler.status, ...(handler.error ? { error: handler.error } : {}),
        turns: handler.turns, calls: handler.calls, texts: handler.texts,
        ...(handler.answer ? { answer: handler.answer } : {}),
        inputTokens: handler.inputTokens, outputTokens: handler.outputTokens,
      },
      ...(judge ? {
        judge: {
          provider: options.judgeModel.provider, model: options.judgeModel.model,
          items: judge.items, notes: judge.notes,
          inputTokens: judge.inputTokens, outputTokens: judge.outputTokens,
        },
      } : {
        judge: {
          provider: options.judgeModel.provider, model: options.judgeModel.model, items: [],
          notes: '', inputTokens: 0, outputTokens: 0, ...(judgeError ? { error: judgeError } : {}),
        },
      }),
      verdict,
      failedItems: HANDLER_ITEMS.filter((id) => items.find((item) => item.id === id)?.pass !== true),
      gaps,
      primaryGap: primaryGap(gaps),
      tokens: reportTokens + handler.inputTokens + handler.outputTokens + (judge?.inputTokens ?? 0) + (judge?.outputTokens ?? 0),
      latencyMs: Date.now() - started,
    }, [...sourceEvidence, ...sourceBodies]);
  } finally {
    await agent.close();
  }
}
