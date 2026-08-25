# ADR-0023: Investigation knowledge graph (Phase 8)

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Durable, queryable provenance relations after evidence intelligence
- **Supersedes**: none
- **Related**: ADR-0020, ADR-0021, ADR-0022
- **Note**: ADR-0021 introduced the graph; ADR-0022 is evidence intelligence. This ADR records the Phase 8 production contract.

## Context

Hypotheses, evidence, memory, and incidents already exist as rows. ADR-0021 added `InvestigationRelation`. After ADR-0022 weighted evidence, operators still need a stable way to query “what supports this?” and “what looked like this before?” without a graph database or embeddings.

Operational intelligence is represented through explicit provenance relationships.

Pi-Ops owns graph data, provenance, and lifecycle. Pi Runtime owns reasoning execution.

## Decision

```text
Hypothesis ──SUPPORTED_BY / CONTRADICTED_BY──▶ Evidence
MemoryCandidate ──DERIVED_FROM──▶ ReasoningResult
Incident ──SIMILAR_TO──▶ Incident
Incident ──RESOLVED_BY──▶ Hypothesis
```

### Automatic edges

- Hypothesis creation writes Evidence edges
- MemoryCandidate creation writes a DERIVED_FROM edge
- Similarity lookup writes SIMILAR_TO edges (insert-or-ignore)

### Similarity

`SimilarIncidentService` (`createIncidentSimilarityService`) matches same service, same type, and similar fingerprint dimensions. No embeddings, no vector store, no GraphRAG.

### Context

`InvestigationContext` includes related incidents, historical hypotheses, and previous resolutions. The object is frozen. Incident and Evidence rows are never rewritten.

Relation inserts are idempotent. Duplicate creates return the existing row.

## Consequences

Benefits:

- provenance is queryable by from/to/type
- similar incidents become durable edges, not a one-off lookup

Costs:

- SQLite adjacency list, not a graph engine

## Supersession rule

Do not introduce a graph database, vector index, or GraphRAG to store these relations.
