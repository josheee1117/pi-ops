# ADR-0024: Operational knowledge retrieval

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How past investigations are selected as supporting context for a new Incident
- **Supersedes**: none
- **Related**: ADR-0010, ADR-0017, ADR-0021, ADR-0022, ADR-0023

## Context

The knowledge graph and memory store hold similar incidents, hypotheses, resolutions, and approved memory. Dumping them unranked into InvestigationContext would drown current Evidence. A retrieval bug must not stop a new investigation.

Pi-Ops owns retrieval, ranking, and provenance. Pi Runtime owns reasoning.

## Decision

```text
IncidentContext
  → InvestigationKnowledgeRetriever
  → KnowledgeContext (ranked, provenanced)
  → InvestigationContext.historicalKnowledge
```

`KnowledgeContext` contains:

- similar incidents
- historical hypotheses
- previous resolutions
- related memories

### Ranking

Deterministic, no embeddings:

1. structural similarity score
2. resolution success from MemoryFeedback
3. derived memory quality (effectiveness / success ratio)

Low-quality memory (only FAILED feedback, or effectiveness below 0.5 after use) is omitted.

### Provenance

Every retrieved item records `sourceRelationType` / optional `sourceRelationId`, `sourceIncidentId`, and/or `sourceMemoryEntryId`.

### Failure is optional

A retriever exception yields an empty KnowledgeContext. Event ingest, Evidence collection, and InvestigationSession start continue. InvestigationContext remains frozen.

This milestone does not add a vector database, embeddings, or GraphRAG.

## Consequences

Benefits:

- new investigations can cite ranked history without treating it as Evidence
- low-quality memory stays out of the handoff

Costs:

- ranking is coarse; a later ADR may refine weights

## Supersession rule

Do not inject unbounded historical knowledge into InvestigationContext or treat retrieved items as observed Evidence.
