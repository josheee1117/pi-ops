import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

export const DEFAULT_MAX_RUNTIME_CONTEXT_BYTES = 16_384;

const KNOWLEDGE_KEYS = [
  'similarIncidents',
  'historicalHypotheses',
  'previousResolutions',
  'relatedMemories',
] as const;

export function boundInvestigationContext(
  context: RuntimeInvestigationContext,
  maxBytes = DEFAULT_MAX_RUNTIME_CONTEXT_BYTES,
): RuntimeInvestigationContext {
  const clone = structuredClone(context) as RuntimeInvestigationContext & {
    historicalKnowledge?: Record<string, unknown>;
  };
  trimKnowledge(clone, 5);
  while (jsonSize(clone) > maxBytes) {
    const knowledge = clone.historicalKnowledge;
    if (!knowledge || !hasKnowledgeItems(knowledge)) {
      clone.historicalKnowledge = {
        similarIncidents: [],
        historicalHypotheses: [],
        previousResolutions: [],
        relatedMemories: [],
      };
      break;
    }
    shrinkKnowledge(knowledge);
  }
  return clone;
}

export function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function trimKnowledge(
  context: { historicalKnowledge?: Record<string, unknown> },
  limit: number,
): void {
  const knowledge = context.historicalKnowledge;
  if (!knowledge) return;
  for (const key of KNOWLEDGE_KEYS) {
    const value = knowledge[key];
    if (Array.isArray(value)) knowledge[key] = value.slice(0, limit);
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
