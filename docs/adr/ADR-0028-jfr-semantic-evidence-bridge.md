# ADR-0028: JFR semantic evidence bridge

- **Status**: Accepted
- **Date**: 2026-09-07
- **Scope**: How a persisted JFR OpsEvent becomes current Investigation Evidence without giving Pi Runtime JVM/JFR capability
- **Supersedes**: none
- **Related**: ADR-0025, ADR-0026

## Context

DataAsset already posts JFR `OpsEvent`s. Those Events form Incidents, but JVM-local facts never became Evidence, so the JVM Specialist could only infer from host/docker signals.

## Decision

```text
JFR OpsEvent (accepted, Incident linked)
  → Pi-Ops deterministic semantic projection
  → canonical Evidence kind jfr.signal
  → InvestigationContext
  → JVM Specialist / Coordinator
```

- Identity is `jfr-${event.id}`: retry-safe and bound to the immutable Event.
- Attributes are allowlisted per known event type from the DataAsset wire contract. Unknown JFR types persist public envelope fields only (`eventId`, `eventType`, `observedAt`, `message`) with empty `attributes`.
- Projection is local Event → Evidence. It does not call Node Agent, JFR, or the JVM.
- `jfr.signal` is push-derived current Evidence. It is not in `RUNTIME_ALLOWED_EVIDENCE_TYPES`. Runtime `missingEvidence: ["jfr.signal"]` is invalid. `noTools: 'all'` stays.
- Model-facing rows still pass `toRuntimeSafeEvidence`. Host/docker Evidence is kept alongside JFR; ranking must not erase cross-layer conflict.

## Consequences

JVM Specialists can cite first-party JFR facts by Evidence ID. Pi Runtime still cannot start recordings or query a JVM.
