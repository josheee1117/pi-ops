# ADR-0008: Reasoning strategy boundary

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Where Pi-Ops stops and Pi Runtime may later orchestrate multi-expert analysis
- **Supersedes**: none
- **Related**: ADR-0001, ADR-0006

## Context

Today a ReasoningJob selects a Reasoner (`fake` or `pi`) and the worker calls `reasoner.reason(incident, evidence)` directly.

Future multi-agent analysis (planner, expert delegation, parallel specialists) must not be implemented inside Pi-Ops. If the worker keeps calling Reasoner as the only seam, agent orchestration would leak into incident/evidence execution tracking.

Pi-Ops needs a named strategy boundary now, without adding an agent framework.

## Decision

Insert a ReasoningStrategy between job execution and Reasoner:

```text
ReasoningJob
  → ReasoningStrategy
  → Reasoner
  → ReasoningResult
```

Strategies:

| Name | Meaning in v0.1 |
|---|---|
| `deterministic` | Local FakeReasoner. Pi-Ops executes it inline. |
| `single_reasoner` | One PiReasoner call. No experts, no planner. |
| `delegated_analysis` | Reserved. Owned by Pi Runtime. Pi-Ops must not implement agents here. |

Reasoner type `fake` maps to `deterministic`. Other configured reasoners map to `single_reasoner`. Selecting `delegated_analysis` fails closed until a Pi Runtime adapter exists.

### Ownership

Pi-Ops owns:

- incident lifecycle
- evidence collection
- ReasoningJob execution tracking (PENDING / RUNNING / COMPLETED / FAILED)
- persistence of ReasoningResult

Pi Runtime owns (not in this repository yet):

- agent orchestration
- expert delegation
- final reasoning when the strategy is `delegated_analysis`

Pi-Ops must not add a planner, workflow engine, or agent SDK to implement `delegated_analysis`.

## Consequences

Benefits:

- current FakeReasoner / PiReasoner behavior is unchanged
- a later runtime adapter can sit behind one strategy name
- incident/evidence code stays free of agent graphs

Costs:

- `delegated_analysis` is a stub that fails rather than a working multi-agent path

## Supersession rule

Do not implement agent orchestration inside `apps/agent` without a new ADR that reassigns this boundary.
