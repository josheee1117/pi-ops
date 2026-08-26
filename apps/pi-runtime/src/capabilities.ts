import {
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
} from '@pi-ops/protocol';

export const runtimeCapabilities = {
  evidenceTypes: RUNTIME_ALLOWED_EVIDENCE_TYPES,
  forbidden: RUNTIME_FORBIDDEN_CAPABILITIES,
} as const;

export function assertReadOnlyEvidenceType(type: string): asserts type is typeof RUNTIME_ALLOWED_EVIDENCE_TYPES[number] {
  if (!(RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unsupported evidence request type: ${type}`);
  }
  if ((RUNTIME_FORBIDDEN_CAPABILITIES as readonly string[]).includes(type)) {
    throw new Error(`forbidden capability: ${type}`);
  }
}
