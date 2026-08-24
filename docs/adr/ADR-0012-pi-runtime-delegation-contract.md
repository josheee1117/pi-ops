# ADR-0012: Pi Runtime delegation contract

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How Pi-Ops hands an InvestigationPlan to an external Pi Runtime without hosting agents
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0011

## Context

ADR-0011 made `delegated_analysis` persist an InvestigationPlan and fail the job. Treating a successful handoff as `FAILED` is wrong: Pi-Ops finished its work and is waiting.

A later Pi Runtime will submit/poll over a real transport. Pi-Ops must define that contract now, without embedding Pi SDK, planner, tools, or HTTP.

## Decision

```text
ReasoningJob
  → InvestigationPlan
  → PiRuntimeClient.submit(plan)
  → WAITING_DELEGATION
  → (future) poll → DelegatedReasoningResult
```

### Lifecycle

`WAITING_DELEGATION` means the plan is persisted and the job is not eligible for another local Reasoner run. It is not a failure.

Unknown strategies still fail closed as `FAILED`. `deterministic` / `single_reasoner` are unchanged.

### Contract

`PiRuntimeClient` is replaceable:

- `submit(plan)` — accept the InvestigationPlan
- `poll(planId)` — placeholder for a later DelegatedReasoningResult

The in-process implementation is a no-op client. No provider/model config and no Pi SDK.

`DelegatedReasoningResult` is the inbound shape (summary, confidence, evidence ids, optional memory ids). Applying it to a ReasoningResult is a later milestone.

### Ownership

Pi-Ops: incident, evidence, ReasoningJob lifecycle, InvestigationPlan.

Pi Runtime: agent orchestration, tool execution, final synthesis.

## Consequences

Benefits:

- delegated jobs wait instead of looking broken
- a real adapter can implement the same interface later

Costs:

- poll/apply is not implemented yet; jobs remain WAITING until a later ingest path exists

## Supersession rule

Do not add planner, tools, shell, or Pi SDK orchestration to `apps/agent` to "complete" WAITING jobs.
