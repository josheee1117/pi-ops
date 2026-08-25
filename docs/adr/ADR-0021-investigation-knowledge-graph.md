# ADR-0021: Investigation knowledge graph

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Provenance-preserving relations between Incident, Evidence, Hypothesis, and Memory
- **Supersedes**: none
- **Related**: ADR-0017, ADR-0018, ADR-0019, ADR-0020

## Context

Incidents, Evidence, Hypotheses, and Memory are persisted as independent rows. Operators and future tooling cannot see which evidence supports a hypothesis, which memory derives from which ReasoningResult, or which past incidents resemble the current one.

Pi-Ops owns the operational knowledge graph, provenance, and lifecycle. Pi Runtime owns reasoning execution. This milestone adds the relationship layer without agents, tools, or a workflow engine.

## Decision

Operational intelligence is represented as provenance-preserving relationships.

```text
InvestigationHypothesis ──SUPPORTED_BY──▶ Evidence
InvestigationHypothesis ──CONTRADICTED_BY─▶ Evidence
MemoryCandidate ──DERIVED_FROM──▶ ReasoningResult
Incident ──SIMILAR_TO──▶ Incident
Incident ──RESOLVED_BY──▶ Hypothesis
```

### Relations

`InvestigationRelation` records `fromType`, `fromId`, `toType`, `toId`, `relationType`, and `createdAt`. Relation types: `SUPPORTED_BY`, `CONTRADICTED_BY`, `SIMILAR_TO`, `RESOLVED_BY`, `DERIVED_FROM`. Rows are append-only and never rewritten.

Graph edges are created when an entity is created:

- Hypothesis creation links each supporting / contradicting Evidence
- MemoryCandidate creation links the deriving ReasoningResult

### Similarity

`IncidentSimilarityService` matches structural dimensions only: same service, same type, matching node, and overlapping fingerprint dimensions (e.g. same `sqlFingerprint` or business code). There are no embeddings and no vector index. Scores are deterministic.

### Historical context

`InvestigationContext` gains `relatedIncidents`, `historicalResolutions` (SUPPORTED hypothesis statements from related incidents), and `similarHypotheses`. The original Incident and Evidence rows are never modified.

A graph or similarity lookup failure degrades to empty history. It never blocks Event ingest, Evidence collection, or ReasoningJob execution.

## Consequences

Benefits:

- provenance is queryable without reading every row
- operators can see supporting vs contradicting evidence
- past resolutions inform future investigations

Costs:

- similarity is structural, not semantic; embeddings are later work

## Supersession rule

Do not merge, delete, or rewrite InvestigationRelation rows to "clean up" the graph.
