import { deterministicSummary, investigationSummarySchema, type InvestigationSummary } from '@pi-ops/protocol';
import type { NotificationPayload } from './notification.js';

export function plainSummary(notification: NotificationPayload): InvestigationSummary {
  const fallback = deterministicSummary(notification.incident, notification.summarySeverity);
  const parsed = investigationSummarySchema.safeParse(notification.analysis?.diagnosis?.summary);
  let summary = parsed.success ? { ...parsed.data, severity: fallback.severity } : fallback;
  const recovered = notification.type === 'INCIDENT_RECOVERED' || notification.incident.state === 'RECOVERED'
    || notification.notice === 'recovered-before-delivery';
  if (recovered) return { ...summary,
    whatHappened: notification.notice === 'recovered-before-delivery' ? '该故障曾发生，首次通知送达前已恢复。' : '已收到恢复事实，请核对业务是否恢复。',
    recovery: ['验证：检查健康响应和关键业务请求，确认错误与超时恢复。'],
  };
  if (notification.notice === 'manual-confirmation') summary = { ...fallback, whatHappened: '错误在等待期后仍持续，影响尚未确认，需要人工确认。' };
  else if (notification.analysis?.hypothesis.startsWith('诊断不完整')) summary = { ...fallback, whatHappened: `${fallback.whatHappened}诊断不完整，先按建议止损并获取详情。` };
  const actions = notification.analysis?.diagnosis?.actions ?? [];
  if (notification.analysis && !actions.some((action) => action.purpose === 'repair')
    && !summary.recovery.some((line) => /修复(?:方案)?(?:尚未确定|未确定|未知|待确认|待核实)/.test(line))) {
    const target = actions.find((action) => action.purpose === 'evidence_collection')?.target;
    const unknown = `修复尚未确定：${target ? `先核对${target}，按详情补证动作及其前提采证后确定修复方向。` : '先核对故障版本源码、当前配置与接口契约，取得实际差异后确定修复方向。'}`;
    const recovery = [...summary.recovery];
    const line = unknown.length <= 100 ? unknown : '修复尚未确定：先按详情中首个补证动作及其前提采证，用结果确认修复方向。';
    if (recovery.length === 3) recovery[1] = line;
    else recovery.push(line);
    summary = { ...summary, recovery };
  }
  return summary;
}
