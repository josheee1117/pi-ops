import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { RuntimeModel } from '../model.js';
import { criteriaFor, HANDLER_ITEMS, GAP_ITEMS } from './closed-loop-cases.js';
import { runJudge, type HandlerResult, type JudgeItem } from './closed-loop-agent.js';
import {
  deriveGaps, deriveVerdict, diagnosisExcerpt, loadSourceFixtures, primaryGap,
  type ClosedLoopCaseResult, type ClosedLoopVerdict, type GapKind,
} from './closed-loop-runner.js';
import { gapLabel } from './closed-loop-report.js';
import { withoutSourceSnippetBodies } from './agent-chain.js';

/**
 * Re-runs only the judge against already stored handler answers.
 * Messages, diagnoses and handler plans are read from the source directory;
 * nothing is regenerated and the source directory is never written.
 */

export interface RejudgeChangedItem {
  id: string;
  oldPass: boolean | undefined;
  newPass: boolean;
  reason: string;
}

export interface RejudgeCaseResult {
  caseId: string;
  source: string;
  oldVerdict: ClosedLoopVerdict;
  newVerdict: ClosedLoopVerdict;
  changed: RejudgeChangedItem[];
  oldItems: JudgeItem[];
  newItems: JudgeItem[];
  newGaps: GapKind[];
  newPrimaryGap: GapKind | null;
  judge: { provider: string; model: string; inputTokens: number; outputTokens: number };
  tokens: number;
  latencyMs: number;
  error?: string;
}

interface SavedCase {
  criteria?: unknown;
  result: ClosedLoopCaseResult;
}

function storedHandler(result: ClosedLoopCaseResult): HandlerResult {
  return {
    status: result.handler.status,
    ...(result.handler.answer ? { answer: result.handler.answer } : {}),
    ...(result.handler.error ? { error: result.handler.error } : {}),
    turns: result.handler.turns,
    calls: result.handler.calls,
    texts: result.handler.texts ?? [],
    inputTokens: 0,
    outputTokens: 0,
  };
}

export async function rejudgeCase(sourceFile: string, options: {
  repoRoot: string;
  judgeModel: RuntimeModel;
  beforeCall?: (requestChars: number) => void;
}): Promise<RejudgeCaseResult> {
  const started = Date.now();
  const saved = JSON.parse(readFileSync(sourceFile, 'utf8')) as SavedCase;
  const result = saved.result;
  const criteria = criteriaFor(result.caseId);
  const handler = storedHandler(result);
  const base = {
    caseId: result.caseId, source: sourceFile,
    oldVerdict: result.verdict,
    oldItems: result.judge?.items ?? [],
    judge: { provider: options.judgeModel.provider, model: options.judgeModel.model, inputTokens: 0, outputTokens: 0 },
    tokens: 0,
  };
  if (handler.status !== 'answered') {
    const newGaps: GapKind[] = ['handler_no_answer'];
    return {
      ...base, newVerdict: 'open', changed: [], newItems: [], newGaps,
      newPrimaryGap: primaryGap(newGaps), latencyMs: Date.now() - started,
      error: result.handler.error ?? '处理 agent 未给出结论',
    };
  }
  if (!result.message?.content) throw new Error(`${result.caseId}: saved result has no message`);
  if (!result.detail?.markdown) throw new Error(`${result.caseId}: saved result has no detail markdown`);
  const judge = await runJudge({
    model: options.judgeModel,
    message: result.message.content,
    detailMarkdown: result.detail.markdown,
    criteria,
    diagnosisExcerpt: diagnosisExcerpt(result.diagnosis.report),
    handler,
    sources: loadSourceFixtures(options.repoRoot, criteria),
    ...(options.beforeCall ? { beforeCall: options.beforeCall } : {}),
  });
  const newVerdict = deriveVerdict(criteria, judge.items, handler.status);
  const detailFailed = (result.detail.bytes ?? 0) === 0 || handler.calls.some((call) => call.tool === 'fetch_details' && !call.ok);
  const newGaps = deriveGaps({ verdict: newVerdict, items: judge.items, handler, criteria, detailFailed, diagnosisUnavailable: false });
  const changed: RejudgeChangedItem[] = [...HANDLER_ITEMS, ...GAP_ITEMS].flatMap((id) => {
    const now = judge.items.find((item) => item.id === id);
    if (!now) return [];
    const before = base.oldItems.find((item) => item.id === id);
    if (before && before.pass === now.pass) return [];
    return [{ id, oldPass: before?.pass, newPass: now.pass, reason: now.reason }];
  });
  return {
    ...base,
    newVerdict,
    changed,
    newItems: judge.items,
    newGaps,
    newPrimaryGap: primaryGap(newGaps),
    judge: {
      provider: options.judgeModel.provider, model: options.judgeModel.model,
      inputTokens: judge.inputTokens, outputTokens: judge.outputTokens,
    },
    tokens: judge.inputTokens + judge.outputTokens,
    latencyMs: Date.now() - started,
  };
}

export async function rejudgeDirectory(options: {
  sourceDir: string;
  outDir: string;
  repoRoot: string;
  judgeModel: RuntimeModel;
  caseIds: string[];
  beforeCall?: (requestChars: number) => void;
}): Promise<RejudgeCaseResult[]> {
  const sourceDir = resolve(options.sourceDir);
  const outDir = resolve(options.outDir);
  if (sourceDir === outDir) throw new Error('rejudge output must be a different directory from the source');
  mkdirSync(outDir, { recursive: true });
  const results: RejudgeCaseResult[] = [];
  for (const caseId of options.caseIds) {
    const sourceFile = join(sourceDir, `${caseId}.json`);
    if (!existsSync(sourceFile)) throw new Error(`missing saved case: ${sourceFile}`);
    const casePath = join(outDir, `${caseId}.json`);
    if (existsSync(casePath)) throw new Error(`refuse to overwrite ${caseId}; use a new --out directory`);
    const result = await withoutSourceSnippetBodies(await rejudgeCase(sourceFile, {
      repoRoot: options.repoRoot, judgeModel: options.judgeModel,
      ...(options.beforeCall ? { beforeCall: options.beforeCall } : {}),
    }), loadSourceFixtures(options.repoRoot, criteriaFor(caseId)).map((item) => ({
      kind: 'source.snippet', data: { text: item.content },
    })));
    results.push(result);
    writeFileSync(casePath, `${JSON.stringify({
      criteria: criteriaFor(caseId),
      source: relative(options.repoRoot, sourceFile),
      result: { ...result, source: relative(sourceDir, sourceFile) },
    }, null, 2)}\n`);
  }
  return results;
}

export function renderRejudgeReport(input: {
  results: RejudgeCaseResult[];
  sourceDir: string;
  judge: { provider: string; model: string };
  spent: number;
  budget: number;
  wallMs: number;
}): string {
  const { results } = input;
  const oldClosed = results.filter((item) => item.oldVerdict === 'closed').length;
  const newClosed = results.filter((item) => item.newVerdict === 'closed').length;
  const lines = [
    '# 闭环评测重判：增加无证据断言的通用禁止项',
    '',
    `只重跑裁判。消息、诊断和处理 agent 回答来自 \`${input.sourceDir}\`，没有重新生成，源目录未改动。`,
    `裁判 ${input.judge.provider}/${input.judge.model}，thinking off。已回报 token ${input.spent}，预算 ${input.budget}，耗时 ${Math.round(input.wallMs / 1000)} 秒。`,
    '',
    `旧标准闭环 ${oldClosed}/${results.length}，新标准闭环 ${newClosed}/${results.length}。`,
    '',
    '新标准加了一条通用禁止项：没有证据就断言“业务未受影响 / 无影响”，或断言这次事件是演练 / 测试 / 预期行为，判失败。写成“更像 / 倾向于 / 可能是”也算断言。服务名或环境名带“演练”、代码具备压测能力、日志出现相关字样都不算本次事件的证据；源码明确写明本次故障注入（如 DataAsset）才算。',
    '',
    '| 案例 | 旧判定 | 新判定 | 变化项 | 新卡点 | token | 耗时 ms |',
    '|---|---|---|---|---|---:|---:|',
  ];
  for (const item of results) {
    const changed = item.changed.map((change) => `${change.id} ${change.oldPass === undefined ? '缺' : change.oldPass ? 'pass' : 'fail'}→${change.newPass ? 'pass' : 'fail'}`).join('、') || '无';
    lines.push(`| ${item.caseId} | ${item.oldVerdict} | ${item.newVerdict} | ${changed} | ${item.newPrimaryGap ? gapLabel(item.newPrimaryGap) : '无'} | ${item.tokens} | ${item.latencyMs} |`);
  }
  for (const item of results) {
    lines.push('', `## ${item.caseId}`, '', `旧判定 **${item.oldVerdict}**，新判定 **${item.newVerdict}**。${item.error ? `错误：${item.error}` : ''}`);
    const oldForbidden = item.oldItems.find((entry) => entry.id === 'no_forbidden');
    const newForbidden = item.newItems.find((entry) => entry.id === 'no_forbidden');
    if (newForbidden) {
      lines.push('', '### no_forbidden 新旧理由', '');
      lines.push(`- 旧：${oldForbidden ? (oldForbidden.pass ? 'pass' : 'fail') + '。' + oldForbidden.reason : '没有旧理由'}`);
      lines.push(`- 新：${newForbidden.pass ? 'pass' : 'fail'}。${newForbidden.reason}`);
    }
    if (item.changed.length) {
      lines.push('', '### 变化项', '');
      for (const change of item.changed) {
        lines.push(`- ${change.id}：${change.oldPass === undefined ? '旧标准缺此项' : change.oldPass ? 'pass' : 'fail'} → ${change.newPass ? 'pass' : 'fail'}。${change.reason}`);
      }
    }
    lines.push('', '### 新裁判全部理由', '');
    for (const entry of item.newItems) lines.push(`- ${entry.id} ${entry.pass ? 'pass' : 'fail'}：${entry.reason}`);
  }
  return lines.join('\n') + '\n';
}
