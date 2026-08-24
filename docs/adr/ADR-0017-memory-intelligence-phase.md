# ADR-0017: Memory intelligence phase

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How approved memory becomes feedback-driven operational knowledge without Pi-Ops hosting agents
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0015, ADR-0016

## Context

Through M16, MemoryEntry is a governed snapshot. Retrieval matches type + service + keywords and ranks by approval-time confidence. ADR-0016 already forbids rewriting entry text after feedback.

If Pi-Ops merged competing diagnoses or mutated `confidence` in place, provenance would collapse. If it ranked only by keywords, repeatedly failed memories would stay at the top.

Pi-Ops needs an operational intelligence layer: derived quality, ranked retrieval, explicit conflicts, and a handoff object for Pi Runtime. It must not become a planner, tool host, or remediator.

## Decision

Memory evolves from static storage into feedback-driven operational knowledge.

```text
MemoryFeedback (append-only)
  → derived MemoryQuality
  → ranked MemoryRetriever
  → InvestigationContext (boundary for Pi Runtime)
```

### Quality is derived

A MemoryEntry view may carry `successCount`, `failedCount`, `usageCount`, and `effectivenessScore`. Those numbers are computed from MemoryFeedback rows. Feedback history is never overwritten. Approval-time MemoryEntry content stays immutable.

Unused memory falls back to the approval `confidence` so a failed memory ranks below an unused one.

### Retrieval ranking

Matching remains: ACTIVE + incident type + service + keyword overlap.

Order is:

1. derived effectivenessScore
2. success ratio
3. recent usage
4. usage count
5. keyword overlap
6. id

Low-quality memories stay eligible but rank lower. They are not auto-disabled.

### Conflicts are not merged

If matching memories have more than one distinct conclusion (e.g. Redis vs JVM), the retriever returns the full conflicting list. Pi-Ops does not pick a winner or synthesize a blended conclusion.

### InvestigationContext

`InvestigationContext` is the frozen boundary object for a future Pi Runtime:

- current incident
- current evidence
- related memories (ranked, bounded)
- previous resolutions
- conflicting memories

Pi-Ops owns Event, Incident, Evidence, reasoning lifecycle, memory governance, and feedback history. Pi Runtime owns agent orchestration, tool execution, and model reasoning. This object is not a workflow, and it is not injected as unbounded prompt text.

## Consequences

Benefits:

- operators can see which memories work without rewriting them
- competing diagnoses remain visible
- Pi Runtime receives a typed operational snapshot

Costs:

- quality is a simple average; a later ADR may refine aggregation
- InvestigationContext is not yet transported over HTTP

## Supersession rule

Do not merge conflicting memories, rewrite MemoryEntry content, or execute tools/remediation inside Pi-Ops to “resolve” an InvestigationContext.
