import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

export const DEFAULT_MAX_RUNTIME_CONTEXT_BYTES = 16_384;

const KNOWLEDGE_KEYS = [
  'similarIncidents',
  'historicalHypotheses',
  'previousResolutions',
  'relatedMemories',
] as const;

const LEGACY_CONTEXT_KEYS = [
  'relatedMemories',
  'previousResolutions',
  'relatedIncidents',
  'historicalResolutions',
  'similarHypotheses',
] as const;

export class ContextTooLargeError extends Error {
  readonly code = 'context_too_large';

  constructor() {
    super('context_too_large');
    this.name = 'ContextTooLargeError';
  }
}

export function boundInvestigationContext(
  context: RuntimeInvestigationContext,
  maxBytes = DEFAULT_MAX_RUNTIME_CONTEXT_BYTES,
): RuntimeInvestigationContext {
  const clone = structuredClone(context) as RuntimeInvestigationContext & Record<string, unknown>;
  for (const key of LEGACY_CONTEXT_KEYS) {
    delete clone[key];
  }
  const factsOnly = factsOnlyContext(clone);
  if (jsonSize(factsOnly) > maxBytes) throw new ContextTooLargeError();

  trimKnowledge(clone, 5);
  while (jsonSize(clone) > maxBytes) {
    const knowledge = clone.historicalKnowledge as Record<string, unknown> | undefined;
    if (!knowledge || !hasKnowledgeItems(knowledge)) {
      clone.historicalKnowledge = {
        similarIncidents: [],
        historicalHypotheses: [],
        previousResolutions: [],
        relatedMemories: [],
      };
      clone.conflictingMemories = [];
      break;
    }
    shrinkKnowledge(knowledge);
  }
  if (jsonSize(clone) > maxBytes) throw new ContextTooLargeError();
  return clone;
}

export function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function factsOnlyContext(context: RuntimeInvestigationContext): RuntimeInvestigationContext {
  return {
    schemaVersion: context.schemaVersion,
    incident: context.incident,
    evidence: context.evidence,
  };
}

function trimKnowledge(
  context: { historicalKnowledge?: unknown },
  limit: number,
): void {
  const knowledge = context.historicalKnowledge;
  if (!knowledge || typeof knowledge !== 'object') return;
  const record = knowledge as Record<string, unknown>;
  for (const key of KNOWLEDGE_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) record[key] = value.slice(0, limit);
  }
}

function shrinkKnowledge(knowledge: Record<string, unknown>): void {
  for (const key of KNOWLEDGE_KEYS) {
    const value = knowledge[key];
    if (Array.isArray(value) && value.length > 0) {
      knowledge[key] = value.slice(0, Math.max(0, value.length - 1));
      return;
    }
  }
}

function hasKnowledgeItems(knowledge: Record<string, unknown>): boolean {
  return KNOWLEDGE_KEYS.some((key) => {
    const value = knowledge[key];
    return Array.isArray(value) && value.length > 0;
  });
}
