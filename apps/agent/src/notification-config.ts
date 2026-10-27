import { readFileSync } from 'node:fs';
import { DEFAULT_SUMMARY_SEVERITY, investigationSummarySchema, z, type InvestigationSummary } from '@pi-ops/protocol';

const severityRulesSchema = z.object({
  unavailableTypes: z.array(z.string().min(1)).min(1),
  unavailable: investigationSummarySchema.shape.severity,
  criticalOperation: investigationSummarySchema.shape.severity,
  other: investigationSummarySchema.shape.severity,
}).strict();

export type SummarySeverityRules = z.infer<typeof severityRulesSchema>;

export interface CriticalOperation {
  ruleId: string;
  path?: string;
  operation?: string;
  workflow: string;
  owner?: string;
}

export interface HealthRule {
  ruleId: string;
  ruleVersion: number;
  nodeId: string;
  service: string;
  target: string;
  url: string;
  method: string;
  failureSamples: number;
  intervalMs: number;
  container?: string;
}

export interface ServiceNotificationPolicy {
  unknownImpactWaitMs: number;
  observationMaxGapMs: number;
  criticalOperations: CriticalOperation[];
}

export interface NotificationPolicyConfig {
  summarySeverity?: SummarySeverityRules;
  defaultUnknownImpactWaitMs: number;
  defaultObservationMaxGapMs: number;
  services: Record<string, ServiceNotificationPolicy>;
  healthRules: HealthRule[];
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicyConfig = {
  summarySeverity: DEFAULT_SUMMARY_SEVERITY,
  defaultUnknownImpactWaitMs: 300_000,
  defaultObservationMaxGapMs: 120_000,
  services: {
    'order-service': {
      unknownImpactWaitMs: 300_000,
      observationMaxGapMs: 120_000,
      criticalOperations: [{ ruleId: 'order-submit-v1', operation: 'submitOrder', workflow: '下单演练' }],
    },
    'dataasset-jdk17-local-本地演练': {
      unknownImpactWaitMs: 300_000,
      observationMaxGapMs: 120_000,
      criticalOperations: [{ ruleId: 'jdk17-order-submit-v1', operation: 'submitOrder', workflow: '下单演练' }],
    },
  },
  healthRules: [{ ruleId: 'local-drill-health-v1', ruleVersion: 1, nodeId: 'local-dev', service: 'pi-ops-drill', target: 'pi-ops-drill', url: 'http://pi-ops-drill:8088/health', method: 'GET', failureSamples: 1, intervalMs: 2000, container: 'pi-ops-drill' }],
};

const DATAASSET_OPERATIONS: CriticalOperation[] = [
  { ruleId: 'dataasset-auth-callback-v1', operation: 'GET /auth/{code}', workflow: '登录回调' },
  { ruleId: 'dataasset-auth-client-v1', operation: 'GET /auth/authClientInfo', workflow: '登录初始化' },
  { ruleId: 'dataasset-wework-v1', operation: 'GET /oauth/wework/code', workflow: '企业微信登录' },
  { ruleId: 'dataasset-wework-corp-v1', operation: 'GET /oauth/wework/code/{corp}', workflow: '企业微信登录' },
];
for (const service of ['dataasset', 'data-asset', 'data-asset-service']) {
  DEFAULT_NOTIFICATION_POLICY.services[service] = { unknownImpactWaitMs: 300_000, observationMaxGapMs: 120_000, criticalOperations: DATAASSET_OPERATIONS };
}

export function serviceNotificationPolicy(config: NotificationPolicyConfig, service: string): ServiceNotificationPolicy {
  return config.services[service] ?? {
    unknownImpactWaitMs: config.defaultUnknownImpactWaitMs,
    observationMaxGapMs: config.defaultObservationMaxGapMs,
    criticalOperations: [],
  };
}

export function loadNotificationPolicy(path: string | undefined): NotificationPolicyConfig {
  if (!path) return DEFAULT_NOTIFICATION_POLICY;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(raw) || !positive(raw.defaultUnknownImpactWaitMs) || !positive(raw.defaultObservationMaxGapMs)
    || !record(raw.services) || !Array.isArray(raw.healthRules)) {
    throw new Error('Invalid notification policy: defaults, services and healthRules are required');
  }
  const services: Record<string, ServiceNotificationPolicy> = {};
  for (const [service, value] of Object.entries(raw.services)) {
    if (!record(value) || !positive(value.unknownImpactWaitMs) || !positive(value.observationMaxGapMs)
      || !Array.isArray(value.criticalOperations)) throw new Error(`Invalid notification service policy: ${service}`);
    const criticalOperations: CriticalOperation[] = value.criticalOperations.map((item: unknown) => {
      if (!record(item) || !text(item.ruleId) || !text(item.workflow)
        || (text(item.path) === text(item.operation))
        || (item.path !== undefined && (!text(item.path) || !item.path.startsWith('/')))
        || (item.operation !== undefined && !text(item.operation))
        || (item.owner !== undefined && !text(item.owner))) throw new Error(`Invalid critical operation: ${service}`);
      return {
        ruleId: item.ruleId, workflow: item.workflow,
        ...(text(item.path) ? { path: item.path } : {}),
        ...(text(item.operation) ? { operation: item.operation } : {}),
        ...(text(item.owner) ? { owner: item.owner } : {}),
      };
    });
    services[service] = { unknownImpactWaitMs: value.unknownImpactWaitMs, observationMaxGapMs: value.observationMaxGapMs, criticalOperations };
  }
  const healthRules: HealthRule[] = raw.healthRules.map((item: unknown) => {
    if (!record(item) || !text(item.ruleId) || !positive(item.ruleVersion) || !text(item.nodeId)
      || !text(item.service) || !text(item.target) || !text(item.url) || !text(item.method)
      || !positive(item.failureSamples) || !positive(item.intervalMs)
      || (item.container !== undefined && !text(item.container))) throw new Error('Invalid health notification rule');
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['GET', 'HEAD'].includes(item.method)) throw new Error('Invalid health notification rule URL or method');
    return {
      ruleId: item.ruleId, ruleVersion: item.ruleVersion, nodeId: item.nodeId, service: item.service,
      target: item.target, url: item.url, method: item.method, failureSamples: item.failureSamples, intervalMs: item.intervalMs,
      ...(text(item.container) ? { container: item.container } : {}),
    };
  });
  return { defaultUnknownImpactWaitMs: raw.defaultUnknownImpactWaitMs, defaultObservationMaxGapMs: raw.defaultObservationMaxGapMs, services, healthRules,
    ...(raw.summarySeverity !== undefined ? { summarySeverity: severityRulesSchema.parse(raw.summarySeverity) } : {}),
  };
}

export function criticalOperationFor(policy: ServiceNotificationPolicy, operation: string): CriticalOperation | undefined {
  const clean = operation.split('?')[0] ?? operation;
  const path = clean.replace(/^[A-Z]+\s+/, '');
  return [...policy.criticalOperations].sort((left, right) => Number((left.operation ?? left.path ?? '').includes('{')) - Number((right.operation ?? right.path ?? '').includes('{'))).find((rule) => {
    const expected = rule.operation ?? rule.path;
    const actual = rule.operation ? clean : path;
    if (!expected) return false;
    const left = expected.split('/');
    const right = actual.split('/');
    return left.length === right.length && left.every((part, index) => /^\{[A-Za-z]+\}$/.test(part) ? Boolean(right[index]) : part === right[index]);
  });
}

export function ruleSummarySeverity(type: string, observations: readonly import('./notification-policy.js').NotificationObservation[], config: NotificationPolicyConfig): InvestigationSummary['severity'] {
  const rules = config.summarySeverity ?? DEFAULT_SUMMARY_SEVERITY;
  if (rules.unavailableTypes.includes(type) || observations.some((item) =>
    (item.kind === 'docker' && (item.oomKilled || item.dockerAction === 'oom'))
    || (item.kind === 'jvm-exception' && ['java.lang.OutOfMemoryError', 'java.lang.StackOverflowError'].includes(item.exceptionClass))
    || (item.kind === 'health' && item.binding.kind === 'bound' && item.transition.kind === 'failure'))) return rules.unavailable;
  if (observations.some((item) => item.kind === 'critical-operation'
    || (item.kind === 'critical-task' && item.binding.kind === 'bound' && item.result === 'failed'))) return rules.criticalOperation;
  return rules.other;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
