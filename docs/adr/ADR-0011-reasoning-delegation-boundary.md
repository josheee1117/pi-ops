# ADR-0011: Reasoning delegation contract boundary

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: The durable contract Pi-Ops exposes to a future Pi Runtime without becoming an agent host
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0010

## Context

ADR-0008 named `delegated_analysis` but left it as a throw. A later Pi Runtime needs a stable, auditable handoff: what to investigate, which capabilities are requested, and which ReasoningJob owns the work.

If Pi-Ops executed that plan (planner, sub-agents, tools, shell), it would become an agent framework and violate the observation-first boundary.

## Decision

```text
Incident + Evidence
  → ReasoningJob
  → ReasoningStrategy
  → InvestigationPlan
  → Reasoner            (deterministic / single_reasoner)
     OR fail closed     (delegated_analysis)
```

An InvestigationPlan records:

- reasoningJobId
- strategy
- objectives
- requestedCapabilities

### Strategy behavior

| Strategy | Pi-Ops does |
|---|---|
| `deterministic` | Call FakeReasoner. Persist ReasoningResult with strategy provenance. |
| `single_reasoner` | Call PiReasoner. Persist ReasoningResult with strategy provenance. |
| `delegated_analysis` | Persist InvestigationPlan only. Fail closed. Do not call a Reasoner, planner, tools, or Pi SDK orchestration. |

Unknown reasoner types / missing strategies fail closed. No silent fallback to another strategy.

### Ownership

Pi-Ops owns:

- incident lifecycle
- evidence collection
- reasoning job lifecycle
- InvestigationPlan persistence

Pi Runtime owns:

- agent orchestration
- tool execution
- final synthesis for `delegated_analysis`

FakeReasoner and PiReasoner rules do not change.

## Consequences

Benefits:

- a future runtime adapter has a typed plan to consume
- Pi-Ops cannot accidentally grow a workflow engine behind the same job worker

Costs:

- `delegated_analysis` jobs remain FAILED until a runtime adapter exists

## Supersession rule

Do not execute InvestigationPlan capabilities inside `apps/agent` without a new ADR.
