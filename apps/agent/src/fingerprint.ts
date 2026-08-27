import type { OpsEvent } from '@pi-ops/protocol';

export const RECOVERY_TYPE_MAP: Readonly<Record<string, string>> = {
  'health.recovered': 'health.failure',
  'host.memory_recovered': 'host.memory_pressure',
  'host.disk_recovered': 'host.disk_pressure',
  'application.slow_sql_recovered': 'application.slow_sql',
};

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
function typeSpecificDimensions(event: FingerprintEvent): string[] {
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
      return module ? [code, module] : [code];
    }
    default:
      return [];
  }
}

/**
 * Deterministic Incident identity. Never includes timestamps or message text.
 */
export function computeFingerprint(event: FingerprintEvent): string {
  const canonicalType = RECOVERY_TYPE_MAP[event.type] ?? event.type;
  return JSON.stringify([
    event.source,
    event.nodeId,
    event.service,
    canonicalType,
    ...typeSpecificDimensions(event),
  ]);
}
