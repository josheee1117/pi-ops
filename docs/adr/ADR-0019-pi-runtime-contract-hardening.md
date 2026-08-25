# ADR-0019: Pi Runtime contract hardening

- **Status**: Superseded by ADR-0019-pi-runtime-production-contract
- **Date**: 2026-08-21
- **Scope**: Idempotent, versioned, asynchronous integration with Pi Runtime
- **Supersedes**: none
- **Related**: ADR-0012, ADR-0013, ADR-0014, ADR-0018

## Context

ADR-0018 opened an InvestigationSession and accepted an InvestigationReport. A real Pi SDK adapter will retry submits and deliver results later, possibly more than once. If Pi-Ops treated each retry as a new DelegationTask or a new report, provenance and lifecycle would fork.

Pi-Ops owns lifecycle, persistence, validation, and provenance. Pi Runtime owns execution, agent orchestration, and tools. This milestone hardens the contract. It does not add a planner, tools, or remediation.

## Decision

Pi Runtime integration is asynchronous and idempotent.

```text
runtimeRequestId
  → one InvestigationSession (while open)
  → one DelegationTask
  → one runtime task
  → PiRuntimeResultCallback
  → one InvestigationReport
```

### Idempotent submit

A `runtimeRequestId` is derived from Incident + context snapshot hash. A second start/submit of the same request reuses the open session and DelegationTask and does not call Pi Runtime again.

### Callback

`PiRuntimeResultCallback` carries `schemaVersion`, `runtimeTaskId`, `investigationSessionId`, and an InvestigationReport. Pi-Ops validates:

- schema version
- session exists
- DelegationTask belongs to that session
- `runtimeTaskId` matches the task

A duplicate callback returns the existing report. An invalid `runtimeTaskId` writes nothing.

### Reconciliation

Sessions left `SUBMITTED` or `RUNNING` past a timeout are marked `FAILED`. Incident and Evidence are not modified. A later start is a new attempt.

### Versioning

`InvestigationContext` and `InvestigationReport` carry `schemaVersion`. A mismatch is rejected.

## Consequences

Benefits:

- retries from Pi Runtime cannot mint extra tasks or reports
- stuck handoffs do not stay RUNNING forever

Costs:

- HTTP transport is still a replaceable no-op adapter

## Supersession rule

Do not complete a callback by executing tools, a planner, or remediation inside Pi-Ops.
