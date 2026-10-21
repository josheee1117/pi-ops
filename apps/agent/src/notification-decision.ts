import { buildFirstNotificationFactsFromStore } from './notification-stored-facts.js';
import { decideFirstNotification, type FirstNotificationDecision, type FirstNotificationFacts } from './notification-policy.js';
import { buildNotificationJob, incidentFactsFromRow, type NotificationAnalysis } from './notification.js';
import type { NotificationPolicyConfig } from './notification-config.js';
import type { EventStore } from './store.js';

export interface StoredNotificationDecision {
  policyVersion: 1;
  evaluatedAt: string;
  action: FirstNotificationDecision['action'] | 'recover' | 'error';
  reason: string;
  facts?: FirstNotificationFacts;
  missing: string[];
  dueAt?: string;
  valueKeys: string[];
}

export function evaluateNotification(
  store: EventStore,
  incidentId: string,
  policy: NotificationPolicyConfig,
  now: string,
): StoredNotificationDecision | undefined {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} does not exist`);
  const previous = store.getNotificationDecision(incidentId);
  if (!previous) return undefined;
  const facts = buildFirstNotificationFactsFromStore(store, {
    incidentId, eventIds: store.listIncidentEventIds(incidentId), policy, now,
  });
  const decision = decideFirstNotification(facts);
  const value: StoredNotificationDecision = {
    policyVersion: 1, evaluatedAt: now, action: decision.action, reason: decision.reason,
    facts, missing: decision.missing, valueKeys: previous.valueKeys,
    ...(facts.unknownImpactDueAt ? { dueAt: facts.unknownImpactDueAt } : {}),
  };
  store.saveNotificationDecision(incidentId, value);
  const jobs = store.listNotificationJobs(incidentId);
  let initial = jobs.find((job) => job.type === 'INCIDENT_OPEN');
  const recovered = incident.state === 'RECOVERED';
  const evidenceIds = store.listEvidence(incidentId).filter((item) => item.status === 'succeeded').map((item) => item.id);
  if (!initial && (decision.action === 'alert' || (decision.action === 'analyze'
    && decision.reason === 'sustained-impact-unknown' && !recovered))) {
    value.action = 'alert';
    store.saveNotificationDecision(incidentId, value);
    const job = buildNotificationJob({ type: 'INCIDENT_OPEN', incident: incidentFactsFromRow(incident), evidenceIds, now });
    job.payload.notice = recovered ? 'recovered-before-delivery'
      : decision.reason === 'sustained-impact-unknown' ? 'manual-confirmation' : 'fault';
    store.scheduleNotificationJob(job);
    initial = job;
    value.valueKeys = impactKeys(facts);
  }
  if (initial && recovered) {
    value.action = 'recover';
    store.suppressPendingDiagnosisUpdates(incidentId);
    if (initial.status === 'PENDING') {
      initial.payload.incident = { ...initial.payload.incident, ...incidentFactsFromRow(incident) };
      initial.payload.notice = 'recovered-before-delivery';
      store.updatePendingNotificationPayload(initial.id, initial.payload);
    } else if (initial.status === 'DELIVERED' && initial.payload.notice !== 'recovered-before-delivery') {
      store.scheduleNotificationJob(buildNotificationJob({ type: 'INCIDENT_RECOVERED', incident: incidentFactsFromRow(incident), evidenceIds, now }));
    }
  }
  const sessions = store.listAllInvestigationSessions().filter((session) => session.incidentId === incidentId && session.status === 'COMPLETED');
  for (const session of sessions) {
    const report = store.getInvestigationReportBySessionId(session.id);
    if (!report) continue;
    const keys = (report.diagnosis?.actions ?? []).filter((action) => action.purpose === 'repair'
      && action.evidenceIds.length > 0 && action.evidenceIds.every((id) => evidenceIds.includes(id))).map((action) =>
      JSON.stringify([action.target.trim(), action.preconditions.map((item) => item.trim()).sort(), action.operation.trim(), action.expectedResult.trim(), action.risk.trim(), action.requiresApproval]));
    const newValue = keys.some((key) => !value.valueKeys.includes(key));
    const currentImpacts = impactKeys(facts);
    const addedImpacts = currentImpacts.filter((key) => !value.valueKeys.includes(key));
    const newImpact = addedImpacts.length > 0;
    if (!initial || initial.status !== 'DELIVERED' || (!newValue && !newImpact) || recovered || jobs.some((job) => job.type === 'INVESTIGATION_COMPLETED')) continue;
    value.valueKeys = [...new Set([...value.valueKeys, ...keys, ...currentImpacts])];
    const analysis: NotificationAnalysis = {
      investigationSessionId: session.id, reasoningResultId: `reason-${session.id}`,
      hypothesis: report.hypothesis, confidence: report.confidence, recommendation: report.recommendation,
      ...(report.diagnosis ? { diagnosis: report.diagnosis } : {}),
    };
    const update = buildNotificationJob({ type: 'INVESTIGATION_COMPLETED', incident: incidentFactsFromRow(incident), evidenceIds, now,
      investigationSessionId: session.id, reasoningResultId: analysis.reasoningResultId, analysis });
    update.payload.notice = 'diagnosis-update';
    if (newImpact) update.payload.impactSummary = `新增影响事实：${addedImpacts.map(impactLabel).join('；')}。`;
    store.scheduleNotificationJob(update);
    jobs.push(update);
  }
  if (initial) {
    delete value.dueAt;
    if (!recovered) value.action = 'alert';
  }
  store.saveNotificationDecision(incidentId, value);
  return value;
}

function impactLabel(key: string): string {
  if (key === 'docker:oom') return '容器确认遭遇 OOM';
  if (key.startsWith('health:')) return `健康目标不可用（规则 ${key.slice(7)}）`;
  if (key.startsWith('operation:')) return `关键接口失败（规则 ${key.slice(10)}）`;
  return `JVM 错误 ${key.slice(10)}`;
}

function impactKeys(facts: FirstNotificationFacts): string[] {
  return facts.observations.flatMap((item) => {
    if (item.kind === 'critical-operation') return [`operation:${item.ruleId}`];
    if (item.kind === 'health' && item.binding.kind === 'bound') return [`health:${item.binding.ruleId}`];
    if (item.kind === 'jvm-exception' && ['java.lang.OutOfMemoryError', 'java.lang.StackOverflowError'].includes(item.exceptionClass)) return [`exception:${item.exceptionClass}`];
    if (item.kind === 'docker' && (item.oomKilled || item.dockerAction === 'oom')) return ['docker:oom'];
    return [];
  });
}
