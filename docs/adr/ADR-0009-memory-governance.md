# ADR-0009: Memory governance

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How a scored MemoryCandidate becomes durable operational knowledge
- **Supersedes**: none
- **Related**: ADR-0006, ADR-0008
- **Note**: ADR-0004 is not present in this repository

## Context

M10.3 writes MemoryCandidates after a high-score evaluation. A candidate is a proposal, not knowledge. Injecting it into PiReasoner or FakeReasoner would let unreviewed hypotheses become policy.

Approval must be explicit. Retrieval into reasoning is out of scope.

## Decision

Separate **candidate** from **entry**.

```text
ReasoningResult
  → ReasoningEvaluation
  → MemoryCandidate     proposal (PENDING / APPROVED / REJECTED)
  → MemoryEntry         governed knowledge (ACTIVE / DISABLED)
```

### Candidate vs Entry

A MemoryCandidate records the proposed pattern/conclusion copied from one evaluation. Its knowledge fields are immutable. Rows are never deleted.

A MemoryEntry is created only by `approve(candidateId)`. Rejecting a candidate creates no entry. Disabling an entry keeps the row but marks it `DISABLED`, so it is not active.

### Approval is required

Score threshold only creates a candidate. Trust requires `MemoryGovernanceService.approve`. Provenance:

```text
MemoryEntry
  → MemoryCandidate
  → ReasoningEvaluation
  → ReasoningResult
  → ReasoningJob
  → Incident
  → Evidence snapshot
```

`sourceEvaluationId` is stored on both candidate and entry so the justifying evaluation is never inferred.

### Memory is not injected into reasoning

This milestone does not:

- retrieve MemoryEntry into PiReasoner / FakeReasoner
- change prompts or IncidentContext
- add embeddings or a vector store
- add an agent framework

A later ADR is required before any MemoryEntry text enters a Reasoner.

## Consequences

Benefits:

- rejected proposals remain auditable
- approved knowledge can be disabled without rewriting facts
- reasoning stays bounded to current Incident + Evidence

Costs:

- operators must approve before knowledge exists as an entry
- query/retrieval for reasoning is still future work

## Supersession rule

Do not feed MemoryEntry content into reasoning without a new ADR.
