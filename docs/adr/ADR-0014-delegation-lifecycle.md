# ADR-0014: Delegation lifecycle

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Durable DelegationTask between InvestigationPlan and a Pi Runtime
- **Supersedes**: none
- **Related**: ADR-0011, ADR-0012, ADR-0013
- **Note**: ADR-0013 already documents result ingestion; this ADR adds the task lifecycle entity

## Context

ADR-0012/0013 hang delegated work off ReasoningJob `WAITING_DELEGATION` plus an InvestigationPlan. That mixes job lifecycle with external-runtime tracking (submit, running, runtime task id, last error).

Pi-Ops must own the delegation lifecycle. Pi Runtime owns execution.

## Decision

```text
ReasoningJob (WAITING_DELEGATION)
  → InvestigationPlan
  → DelegationTask (PENDING → SUBMITTED → COMPLETED | FAILED)
  → DelegatedReasoningResult (ingest)
  → ReasoningResult
```

A DelegationTask is created when Pi-Ops hands a plan to `PiRuntimeClient.submit`. Submit success marks `SUBMITTED` and may store `runtimeTaskId`. Ingest of a valid DelegatedReasoningResult marks the task `COMPLETED` and the job `COMPLETED`.

Invalid results are rejected. Incident and Evidence are not modified.

Pi-Ops does not run agents, planners, tools, or shell to advance the task.

## Consequences

Benefits:

- external execution state is auditable without overloading ReasoningJob
- ingest can require both plan and task

Costs:

- HTTP transport is still out of scope

## Supersession rule

Do not complete a DelegationTask by executing tools inside Pi-Ops.
