import type { EventStore } from './store.js';

export type InvestigationRelationType =
  | 'SUPPORTED_BY'
  | 'CONTRADICTED_BY'
  | 'SIMILAR_TO'
  | 'RESOLVED_BY'
  | 'DERIVED_FROM';

export type InvestigationNodeType =
  | 'INCIDENT'
  | 'EVIDENCE'
  | 'HYPOTHESIS'
  | 'REASONING_RESULT'
  | 'MEMORY_CANDIDATE';

export interface InvestigationRelation {
  id: string;
  fromType: InvestigationNodeType;
  fromId: string;
  toType: InvestigationNodeType;
  toId: string;
  relationType: InvestigationRelationType;
  createdAt: string;
}

export interface RelationInput {
  fromType: InvestigationNodeType;
  fromId: string;
  toType: InvestigationNodeType;
  toId: string;
  relationType: InvestigationRelationType;
}

export function createInvestigationRelationService(
  store: EventStore,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    create(input: RelationInput): InvestigationRelation {
      if (!input.fromId?.trim() || !input.toId?.trim()) {
        throw new Error('relation fromId and toId are required');
      }
      const relation: InvestigationRelation = {
        id: `irel-${input.fromType}-${input.fromId}-${input.relationType}-${input.toId}`,
        fromType: input.fromType,
        fromId: input.fromId,
        toType: input.toType,
        toId: input.toId,
        relationType: input.relationType,
        createdAt: now(),
      };
      store.insertInvestigationRelation(relation);
      return relation;
    },

    list(filter: {
      fromType?: InvestigationNodeType;
      fromId?: string;
      toType?: InvestigationNodeType;
      toId?: string;
      relationType?: InvestigationRelationType;
    } = {}): InvestigationRelation[] {
      return store.listInvestigationRelations(filter);
    },
  };
}
