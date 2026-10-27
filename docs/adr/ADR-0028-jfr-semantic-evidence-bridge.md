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
- Known projections include `jvm.cpu_pressure` numeric ratios and the local Java17 consumer's `jvm.oom` / `business.error` exception facts. Exceptions retain bounded `exceptionClass`, `exceptionMessage`, `stackTrace`, `jfrStackTrace`, original JFR name/times, container mapping, and business `operation`; unknown attributes are dropped. Only a valid OOME class with exception text/stack recognizes heap OOM; business exceptions require a qualified class with text/stack. Metadata alone stays weak. These are observations, not proof of allocation hotspots, inventory state, or external dependency failure.
- Projection is local Event → Evidence. It does not call Node Agent, JFR, or the JVM.
- `jfr.signal` is push-derived current Evidence. It is not in `RUNTIME_ALLOWED_EVIDENCE_TYPES`. Runtime `missingEvidence: ["jfr.signal"]` is invalid. `noTools: 'all'` stays.
- Model-facing rows still pass `toRuntimeSafeEvidence`. Host/docker Evidence is kept alongside JFR; ranking must not erase cross-layer conflict.

## Consequences

JVM Specialists can cite first-party JFR facts by Evidence ID. Pi Runtime still cannot start recordings or query a JVM.
