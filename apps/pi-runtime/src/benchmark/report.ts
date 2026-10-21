import type { CaseResult } from './runner.js';

/**
 * Aggregate report for the JVM Diagnosis Benchmark.
 *
 * Output is artifact-safe: it contains only model-safe Evidence projections and
 * report text. No API key, Authorization header, or raw credential is written.
 */

export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: 'fake' | 'live';
  provider: string;
  model: string;
  thinkingLevel: string;
  thinkingStatus: string;
  experimentLabel: string | null;
  caseCount: number;
  hardPassCount: number;
  results: CaseResult[];
}

export function buildReport(
  results: CaseResult[],
  meta: { generatedAt?: string; experimentLabel?: string } = {},
): BenchmarkReport {
  const first = results[0];
  return {
    schemaVersion: 1,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    mode: first?.mode ?? 'fake',
    provider: first?.provider ?? 'unknown',
    model: first?.model ?? 'unknown',
    thinkingLevel: first?.thinking.requested ?? 'off',
    thinkingStatus: first?.thinking.status ?? 'unknown',
    experimentLabel: meta.experimentLabel ?? null,
    caseCount: results.length,
    hardPassCount: results.filter((item) => item.evaluation?.hardPass === true).length,
    results,
  };
}

export function renderMessageReport(results: CaseResult[]): string {
  const lines = [results.every((item) => item.mode === 'fake') ? '# fake 值班消息渲染' : '# 真实模型值班消息评测', '', '以下消息来自 agent 渲染器的 fake fetch 捕获，没有外发。自动通过不等于能推进恢复。fake 结果不代表真实模型诊断质量。', '',
    '| 案例 | 模型 | thinking | 输入 token | 输出 token | 耗时 ms | 消息字节 | 自动结果 |',
    '|---|---|---|---:|---:|---:|---:|---|'];
  for (const result of results) {
    lines.push(`| ${result.caseId} | ${result.provider}/${result.model} | ${result.thinking.effective ?? 'unknown'} | ${result.tokenUsage?.input ?? 'unknown'} | ${result.tokenUsage?.output ?? 'unknown'} | ${result.latencyMs} | ${result.message?.bytes ?? '未生成'} | ${result.messageEvaluation?.hardPass === true && result.evaluation?.hardPass === true ? '通过' : '未通过'} |`);
  }
  for (const result of results) {
    lines.push('', `## ${result.caseId}`, '', `状态为 ${result.status}。${result.error ?? ''}`, '');
    const checks = { ...result.evaluation?.checks, ...result.messageEvaluation?.checks };
    if (!Object.keys(checks).length) lines.push('未形成报告，自动内容检查未执行，不能计为通过。');
    for (const [name, value] of Object.entries(checks)) lines.push(`- ${name} ${value.status}。${value.detail ?? ''}`);
    lines.push('', '### 最终消息原文', '', '```text', result.message?.content ?? '未生成最终消息。没有结构化报告，未调用企微渲染器。', '```');
  }
  return lines.join('\n') + '\n';
}

function checkMark(ok: boolean | undefined | null): string {
  if (ok === undefined || ok === null) return '—';
  return ok ? '✅' : '❌';
}

type CheckKey = keyof NonNullable<CaseResult['evaluation']>['checks'];

function statusOf(result: CaseResult, key: CheckKey): boolean | null {
  const checks = result.evaluation?.checks;
  if (!checks) return null;
  const check = checks[key];
  if (!check || check.status === 'not_applicable') return null;
  return check.status === 'pass';
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# JVM Diagnosis Benchmark v1');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 模式：**${report.mode === 'live' ? 'LIVE BENCHMARK' : 'fake (CI harness)'}**`);
  lines.push(`- Provider / Model：\`${report.provider}\` / \`${report.model}\``);
  lines.push(`- thinkingLevel：\`${report.thinkingLevel}\`（${report.thinkingStatus}）`);
  lines.push(`- Hard pass：**${report.hardPassCount} / ${report.caseCount}**`);
  lines.push('');
  lines.push('> fake 模式只证明 harness / fixtures / evaluator 稳定，不能证明诊断质量。');
  lines.push('');
  lines.push('| Case | Hard | Evidence Citation | Conflict | Missing Evidence | Uncertainty | Score | Latency | Tokens |');
  lines.push('|------|------|-------------------|----------|------------------|-------------|-------|---------|--------|');
  for (const result of report.results) {
    const checks = result.evaluation?.checks;
    const tokens = result.tokenUsage ? `${result.tokenUsage.input}/${result.tokenUsage.output}` : '—';
    lines.push([
      `\`${result.caseId}\``,
      checkMark(result.evaluation?.hardPass ?? null),
      checkMark(checks ? checks.evidenceIdsValid.status !== 'fail' && checks.requiredKindsCited.status !== 'fail' : null),
      checkMark(statusOf(result, 'conflictPreserved')),
      checkMark(statusOf(result, 'missingEvidenceValid')),
      checkMark(statusOf(result, 'uncertaintyDiscipline')),
      result.evaluation?.machineScore === null || result.evaluation?.machineScore === undefined
        ? '—'
        : String(result.evaluation.machineScore),
      `${result.latencyMs}ms`,
      tokens,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  lines.push('## 逐 Case 详情');
  lines.push('');
  for (const result of report.results) {
    lines.push(`### \`${result.caseId}\``);
    lines.push('');
    lines.push(`- 状态：${result.status}${result.error ? `（${result.error}）` : ''}`);
    lines.push(`- 引用 Evidence：${result.evaluation?.citedEvidenceIds.join(', ') || '无'}`);
    if (result.evaluation && result.evaluation.notMachineScorable.length > 0) {
      lines.push(`- NOT_MACHINE_SCORABLE：${result.evaluation.notMachineScorable.join(', ')}`);
    }
    if (result.evaluation && result.evaluation.advisoryRemediationMentions.length > 0) {
      lines.push(`- 建议中提及的补救手段（仅供人工评审，非 hard fail）：${result.evaluation.advisoryRemediationMentions.join(', ')}`);
    }
    if (result.evaluation) {
      const failed = Object.entries(result.evaluation.checks)
        .filter(([, value]) => value.status === 'fail')
        .map(([name, value]) => `${name}: ${value.detail ?? ''}`);
      if (failed.length > 0) {
        lines.push('- ❌ hard checks：');
        for (const item of failed) lines.push(`  - ${item}`);
      }
    }
    const errors = result.modelCalls.filter((item) => item.status === 'error');
    const failedRoles = Object.entries(result.specialistStatus)
      .filter(([, status]) => status === 'failed')
      .map(([role]) => role);
    if (errors.length > 0 || failedRoles.length > 0) {
      lines.push('- ⚠️ specialist 失败原因：');
      for (const item of errors) lines.push(`  - [${item.role}] invoke error: ${item.error}`);
      for (const role of failedRoles) {
        if (errors.some((item) => item.role === role)) continue;
        const last = [...result.modelCalls].reverse().find((item) => item.role === role && item.status === 'ok');
        if (last?.text) {
          lines.push(`  - [${role}] 输出未通过结构化校验（${last.chars} chars），原文片段：`);
          lines.push('');
          lines.push('    ```text');
          for (const line of last.text.split('\n').slice(0, 12)) lines.push(`    ${line}`);
          lines.push('    ```');
        } else {
          lines.push(`  - [${role}] 失败，但没有捕获到可解释输出`);
        }
      }
    }
    if (result.investigation.report) {
      lines.push('');
      lines.push(`**hypothesis**：${result.investigation.report.hypothesis}`);
      lines.push('');
      lines.push(`**confidence**：${result.investigation.report.confidence}`);
      lines.push('');
      lines.push(`**recommendation**：${result.investigation.report.recommendation}`);
    }
    lines.push('');
  }
  lines.push('## 语义质量（需人工/外部评审）');
  lines.push('');
  lines.push('以下维度不做关键词测试，由独立 Reviewer 基于上面的完整输出评分：');
  lines.push('');
  lines.push('- 根因方向是否正确');
  lines.push('- 是否存在无证据支撑的断言');
  lines.push('- 诊断有用性');
  lines.push('- confidence 校准');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
