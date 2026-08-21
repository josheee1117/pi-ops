# ADR-0010: Memory retrieval boundary

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How approved MemoryEntry may be selected as supporting context for a ReasoningJob
- **Supersedes**: none
- **Related**: ADR-0006, ADR-0009

## Context

M10.4 stores governed MemoryEntry rows. If the reasoner read the whole store, unranked history would drown current Evidence. If retrieval failed closed, a memory bug would stop Incident processing.

Retrieval must be a separate, optional, bounded step.

## Decision

```text
Incident + Evidence
  → IncidentContext
  → MemoryRetriever.retrieve
  → usedMemoryEntryIds (provenance)
  → ReasoningStrategy → Reasoner
```

### Retrieval is separate from reasoning

`MemoryRetriever` selects at most N ACTIVE entries with deterministic matching:

- incident type
- service (via MemoryEntry → Candidate → ReasoningResult → Incident)
- pattern keyword overlap

DISABLED entries, REJECTED/PENDING candidates, and zero-overlap rows are ignored. There are no embeddings and no vector index.

The Reasoner still receives Incident + Evidence only. Retrieved memory is supporting context recorded as `usedMemoryEntryIds` on the ReasoningResult. It is not treated as an observed fact and cannot override Evidence.

### Memory is optional

No matches, or a retriever exception, must not fail:

- Event ingest
- Incident lifecycle
- Evidence collection
- ReasoningJob execution

The job continues with an empty memory id list.

### Memory cannot override evidence

Collectors remain the source of facts. Memory is historical hypothesis that a human approved. Prompts must not dump the full memory store.

## Consequences

Benefits:

- approved knowledge can be cited without changing FakeReasoner/PiReasoner rules
- retrieval bugs cannot take down the observation pipeline

Costs:

- keyword overlap is coarse
- PiReasoner does not yet see memory text in the prompt (a later ADR)

## Supersession rule

Do not inject unbounded MemoryEntry text into IncidentContext or treat memory as Evidence without a new ADR.
