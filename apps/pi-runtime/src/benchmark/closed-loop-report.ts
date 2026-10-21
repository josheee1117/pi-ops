import type { ClosedLoopCaseResult, GapKind } from './closed-loop-runner.js';

const GAP_LABELS: Record<GapKind, string> = {
  detail_fetch_failed: '详情取不到',
  missing_source: '缺源码等外部能力',
  diagnosis_wrong: '诊断本身错',
  message_insufficient: '消息信息不够',
  handler_no_answer: '处理 agent 未给出可用结论',
  handler_reasoning: '处理方案本身有问题',
  diagnosis_unavailable: '诊断未生成',
};

export function gapLabel(gap: GapKind): string {
  return GAP_LABELS[gap];
}

export function renderClosedLoopReport(input: {
  results: ClosedLoopCaseResult[];
  diagnosis: { provider: string; model: string; thinking: string };
  handler: { provider: string; model: string };
  judge: { provider: string; model: string };
  mode: 'fake' | 'live';
  spent: number;
  budget: number;
  wallMs: number;
}): string {
  const { results } = input;
  const counts = { closed: 0, partial: 0, open: 0 };
  for (const item of results) counts[item.verdict] += 1;
  const lines: string[] = [
    '# 值班消息闭环评测',
    '',
    input.mode === 'fake'
      ? 'fake 模型结果，只证明装置可运行，不代表真实闭环率。'
      : `真实模型：诊断 ${input.diagnosis.provider}/${input.diagnosis.model}（thinking ${input.diagnosis.thinking}），处理 ${input.handler.provider}/${input.handler.model}，裁判 ${input.judge.provider}/${input.judge.model}。`,
    '',
    `闭环 ${counts.closed}/${results.length}，部分闭环 ${counts.partial}，未闭环 ${counts.open}。已回报 token ${input.spent}，预算 ${input.budget}。总耗时 ${Math.round(input.wallMs / 1000)} 秒。`,
    '判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。',
    '',
    '| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |',
    '|---|---|---:|---:|---:|---|---|---|---:|---:|',
  ];
  for (const item of results) {
    const label = `${item.diagnosis.status}${item.diagnosis.degraded ? '（降级）' : ''}${item.diagnosis.reportHardPass ? '' : '（自动检查未过）'}`;
    lines.push(`| ${item.caseId} | ${label} | ${item.message?.bytes ?? '无'} | ${item.detail?.bytes ?? '无'} | ${item.handler.turns} | ${item.verdict} | ${item.failedItems.join('、') || '无'} | ${item.primaryGap ? gapLabel(item.primaryGap) : '无'} | ${item.tokens} | ${item.latencyMs} |`);
  }
  lines.push('', '## 卡点分类', '', '按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。');
  if (!results.some((item) => item.gaps.length)) lines.push('', '本批没有未闭环案例，所有卡点列为空。');
  for (const item of results) {
    if (!item.gaps.length) continue;
    lines.push(`- ${item.caseId}：${item.gaps.map(gapLabel).join('、')}${item.error ? `（${item.error}）` : ''}`);
  }
  for (const item of results) {
    lines.push('', `## ${item.caseId}`, '', `判定：**${item.verdict}**。诊断状态 ${item.diagnosis.status}${item.diagnosis.degraded ? '（降级）' : ''}，消息 ${item.message?.bytes ?? 0} 字节，详情 ${item.detail?.bytes ?? 0} 字节。`, '');
    lines.push('### 企微消息原文', '', '```text', item.message?.content ?? '未生成（诊断未完成或种子失败）', '```');
    lines.push('', '### 处理 agent 工具调用', '');
    if (!item.handler.calls.length) lines.push('没有调用工具。');
    for (const call of item.handler.calls) {
      lines.push(`- 第 ${call.turn} 轮 ${call.tool} ${call.ok ? '成功' : '失败'}：${call.argument}${call.note ? `（${call.note}）` : ''}`);
    }
    lines.push('', '### 处理 agent 结论', '');
    lines.push(item.handler.answer ? ['```json', JSON.stringify(item.handler.answer, null, 2), '```'].join('\n') : `未给出：${item.handler.error ?? '无结论'}`);
    if (item.handler.status !== 'answered' && item.handler.texts?.length) {
      lines.push('', '#### 原始输出', '');
      for (const text of item.handler.texts) lines.push(`第 ${text.turn} 轮：`, '```text', text.text, '```');
    }
    lines.push('', '### 裁判理由', '');
    if (!item.judge || !item.judge.items.length) {
      lines.push(item.judge?.error ? `裁判失败：${item.judge.error}` : '未执行裁判。');
    } else {
      for (const judgeItem of item.judge.items) {
        lines.push(`- ${judgeItem.id} ${judgeItem.pass ? 'pass' : 'fail'}：${judgeItem.reason}`);
      }
      if (item.judge.notes) lines.push('', `备注：${item.judge.notes}`);
    }
    lines.push('', '### 源码夹具', '');
    if (!item.sources.length) lines.push('本案例没有源码夹具。');
    for (const source of item.sources) lines.push(`- ${source.path}（${source.label}），sha256 ${source.sha256 ?? '读取失败'}`);
  }
  return lines.join('\n') + '\n';
}
