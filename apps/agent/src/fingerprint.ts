import type { OpsEvent } from '@pi-ops/protocol';
import { criticalOperationFor, DEFAULT_NOTIFICATION_POLICY, serviceNotificationPolicy, type NotificationPolicyConfig } from './notification-config.js';

export const RECOVERY_TYPE_MAP: Readonly<Record<string, string>> = {
  'health.recovered': 'health.failure',
  'host.memory_recovered': 'host.memory_pressure',
  'host.disk_recovered': 'host.disk_pressure',
  'application.slow_sql_recovered': 'application.slow_sql',
};

function canonicalSource(event: FingerprintEvent): string {
  // A JVM fatal crash (OOM, StackOverflow) is an application-tier failure whether
  // captured directly via JFR or recovered from stdout/stderr via Docker logs.
  const type = RECOVERY_TYPE_MAP[event.type] ?? event.type;
  if (type === 'jvm.oom' || type === 'jvm.stack_overflow' || type === 'runtime.oom' || type === 'runtime.stack_overflow') {
    return 'application';
  }
  return event.source;
}

type FingerprintEvent = Pick<OpsEvent, 'source' | 'nodeId' | 'service' | 'type'> & {
  attributes?: OpsEvent['attributes'];
};

function stringAttribute(event: FingerprintEvent, key: string): string | undefined {
  const value = event.attributes?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extra centrally allowlisted dimensions. Producer fingerprints are ignored.
 * JVM CPU/GC keep service-level identity.
 */
function typeSpecificDimensions(event: FingerprintEvent, version: 1 | 2, policy: NotificationPolicyConfig): string[] {
  const type = RECOVERY_TYPE_MAP[event.type] ?? event.type;
  switch (type) {
    case 'application.slow_sql': {
      return [
        stringAttribute(event, 'sqlFingerprint')
          ?? stringAttribute(event, 'statementId')
          ?? '',
      ];
    }
    case 'business.error': {
      const code = stringAttribute(event, 'businessCode')
        ?? stringAttribute(event, 'errorCode')
        ?? '';
      const module = stringAttribute(event, 'module');
      const operation = stringAttribute(event, 'operation');
      const binding = version === 2 && operation ? criticalOperationFor(serviceNotificationPolicy(policy, event.service), operation) : undefined;
      if (binding) return [code, binding.operation ?? binding.path ?? operation ?? ''];
      const dimensions = module ? [code, module] : [code];
      return version === 2 && operation ? [...dimensions, operation.split('?')[0] ?? operation] : dimensions;
    }
    case 'health.failure':
      return version === 2 ? ['target', 'url', 'method', 'containerName'].map((key) => stringAttribute(event, key) ?? '') : [];
    default:
      return [];
  }
}

/**
 * Deterministic Incident identity. Never includes timestamps or message text.
 */
export function computeFingerprint(event: FingerprintEvent, version: 1 | 2 = 2, policy: NotificationPolicyConfig = DEFAULT_NOTIFICATION_POLICY): string {
  const canonicalType = RECOVERY_TYPE_MAP[event.type] ?? event.type;
  return JSON.stringify([
    canonicalSource(event),
    event.nodeId,
    event.service,
    canonicalType,
    ...typeSpecificDimensions(event, version, policy),
  ]);
}
