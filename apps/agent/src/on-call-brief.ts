import { deterministicSummary, investigationSummarySchema, type InvestigationSummary } from '@pi-ops/protocol';
import type { NotificationPayload } from './notification.js';

export function plainSummary(notification: NotificationPayload): InvestigationSummary {
  const fallback = deterministicSummary(notification.incident, notification.summarySeverity);
  const parsed = investigationSummarySchema.safeParse(notification.analysis?.diagnosis?.summary);
  const summary = parsed.success ? { ...parsed.data, severity: fallback.severity } : fallback;
  const recovered = notification.type === 'INCIDENT_RECOVERED' || notification.incident.state === 'RECOVERED'
    || notification.notice === 'recovered-before-delivery';
  if (recovered) return { ...summary,
    whatHappened: notification.notice === 'recovered-before-delivery' ? '该故障曾发生，首次通知送达前已恢复。' : '已收到恢复事实，请核对业务是否恢复。',
    recovery: ['验证：检查健康响应和关键业务请求，确认错误与超时恢复。'],
  };
  if (notification.notice === 'manual-confirmation') return { ...fallback, whatHappened: '错误在等待期后仍持续，影响尚未确认，需要人工确认。' };
  if (notification.analysis?.hypothesis.startsWith('诊断不完整')) return { ...fallback, whatHappened: `${fallback.whatHappened}诊断不完整，先按建议止损并获取详情。` };
  return summary;
}
