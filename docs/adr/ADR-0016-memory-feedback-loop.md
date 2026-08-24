# ADR-0016: Memory feedback loop

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How Pi-Ops records observed outcomes after a MemoryEntry is applied
- **Supersedes**: none
- **Related**: ADR-0009, ADR-0010, ADR-0015

## Context

Approved MemoryEntry rows are governed snapshots (ADR-0009). Retrieval may cite them on a later Incident (ADR-0010). If operators rewrote `pattern` / `conclusion` / `confidence` on the entry after each use, provenance would collapse and a single noisy outcome would erase the approved text.

Memory should improve through observed outcomes, not by editing the original entry.

## Decision

Append a `MemoryFeedback` row after a MemoryEntry is applied to an Incident:

```text
MemoryEntry
  → applied to Incident (optional ReasoningResult)
  → MemoryFeedback (SUCCESS | FAILED | UNKNOWN)
```

Feedback records `memoryEntryId`, `incidentId`, optional `reasoningResultId`, `outcome`, and `effectivenessScore` in `[0, 1]`. Rows are append-only.

The original MemoryEntry knowledge fields are not updated. Approval-time `confidence` is a snapshot, not a live score. Later evolution (raising/lowering trust, disabling, or proposing a new candidate) must read feedback history.

Incident, Evidence, ReasoningResult, and MemoryEntry content stay immutable under this path.

This milestone does not:

- rewrite MemoryEntry text or confidence
- auto-disable memory from FAILED feedback
- inject memory into prompts
- add planner, tools, or remediation

## Consequences

Benefits:

- success and failure remain auditable against Memory + Incident + Reasoning
- approved knowledge is not silently rewritten

Costs:

- live confidence is not yet derived from feedback; a later ADR must define aggregation

## Supersession rule

Do not mutate MemoryEntry content to “improve” it. Evolve from feedback records.
