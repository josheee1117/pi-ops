# ADR-0019: Pi Runtime production contract

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Production-grade asynchronous, idempotent, recoverable Pi Runtime integration
- **Supersedes**: ADR-0019-pi-runtime-contract-hardening
- **Related**: ADR-0012, ADR-0013, ADR-0014, ADR-0018

## Context

ADR-0018 opened an InvestigationSession and accepted an InvestigationReport. A production Pi SDK adapter will retry submits, deliver callbacks late, and sometimes be unavailable. Pi-Ops must stay the lifecycle authority without hosting agents.

Pi-Ops owns lifecycle, persistence, validation, and provenance. Pi Runtime owns agent execution, tools, and model reasoning.

## Decision

Pi Runtime integration is asynchronous, idempotent, and recoverable.

```text
runtimeRequestId
  → one InvestigationSession (while open)
  → one DelegationTask
  → one runtime task
  → InvestigationReportCallback
  → one InvestigationReport
  → ReasoningResult (Incident + Evidence snapshot + Session + runtime task)
```

### Idempotent submit

`runtimeRequestId` is derived from Incident + context snapshot hash. Submitting the same InvestigationSession again does not create another external task or DelegationTask.

If Pi Runtime is unavailable, the session becomes `FAILED`. Incident and Evidence are not modified.

### Callback

`InvestigationReportCallback` carries `schemaVersion`, `runtimeRequestId`, `runtimeTaskId`, `sessionId`, and `report`. Pi-Ops validates ownership, schema version, and evidence ids. A duplicate callback returns the existing report. An invalid callback writes nothing.

### Recovery

`SUBMITTED` without a callback and `RUNNING` past a timeout are reconciled to `FAILED`. A later start is a new attempt.

### Provenance

A ReasoningResult from this loop records Incident, Evidence snapshot hash, InvestigationSession, `runtimeRequestId`, and `runtimeTaskId`.

### Versioning

`InvestigationContext` and `InvestigationReport` carry `schemaVersion`. A mismatch is rejected.

## Consequences

Benefits:

- retries cannot fork lifecycle
- unavailable or silent runtimes cannot corrupt facts
- every investigation result is auditable back to the runtime task

Costs:

- HTTP transport is still a replaceable no-op adapter

## Supersession rule

Do not complete a callback by executing tools, a planner, or remediation inside Pi-Ops.
