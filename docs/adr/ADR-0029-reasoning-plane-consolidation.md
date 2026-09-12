# ADR-0029: Reasoning plane consolidation

- **Status**: Accepted
- **Date**: 2026-09-12
- **Scope**: Which component owns model execution, and what remains inside the control plane
- **Supersedes**: ADR-0011, ADR-0012, ADR-0013, ADR-0014
- **Related**: ADR-0008, ADR-0018, ADR-0025
- **Implementation status**: decision accepted; `apps/agent` cleanup is tracked as PLAN-0002 M4

## Context

ADR-0011–ADR-0014 were written when Pi Runtime did not exist. They defined a submit/poll delegation contract (`PiRuntimeClient.submit`, `WAITING_DELEGATION`, `DelegatedReasoningResult` ingestion) plus a `DelegationTask` lifecycle entity, so an external runtime could be attached later.

ADR-0025 then shipped the real thing: Pi-Ops freezes an InvestigationContext and submits it to `apps/pi-runtime` over HTTP, which runs a bounded coordinator/specialist investigation and returns an InvestigationRuntimeResult callback. That callback is the live path.

Both contracts now exist side by side. Worse, `apps/agent` still assembles an in-process reasoner (`pi-reasoner.ts` via the Pi SDK) alongside the external runtime, so the control plane can call a model directly. The result is two reasoning paths, one of which is not reachable from the production entrypoint.

## Decision

`apps/pi-runtime` is the **only** reasoning plane.

```text
Pi-Ops (apps/agent)                          Pi Runtime (apps/pi-runtime)
  Incident + Evidence                          Coordinator (ADR-0025)
  → InvestigationContext                        → JVM / Database / Container-Host /
  → HttpPiRuntimeClient.submit ──────────────▶      Application specialists
  ◀──────────────── InvestigationRuntimeResult  → synthesis
  → InvestigationReport → ReasoningResult
```

Rules:

- `apps/agent` performs **no** model invocation of its own. No Pi SDK dependency, no in-process reasoner.
- `reasonerType=fake` remains, used only for deterministic local mode and tests. It produces fixed, reproducible output and never calls a model.
- `delegated_analysis` remains the strategy that hands work to the external runtime. It is the production path.
- The `submit`/`poll`/`DelegatedReasoningResult` contract of ADR-0011–ADR-0013 is retired. Result return is the ADR-0025 callback, not a polled delegated result.
- **Retained**: `DelegationTask` is not retired. ADR-0025 makes it part of the attempt graph — one InvestigationSession owns exactly one DelegationTask recording runtimeTaskId and delivery state. Only the ADR-0014 *submit/poll lifecycle* is superseded, not the entity.

## Consequences

Benefits:

- one reasoning path, one place where prompts, thinking level, and provider credentials live
- the control plane cannot silently become an agent host
- `reasonerType` can no longer select a model call by configuration mistake

Costs and migrations:

- the in-process reasoner, its SDK client, its smoke script, and their tests must be deleted (PLAN-0002 M4)
- `PI_OPS_REASONER_TYPE=pi` must fail closed with a message pointing at the external runtime, rather than falling back
- removing `apps/agent/src/pi-reasoner.ts` drops an entry from `reasoning.local.paths` in `features.json`, which Policy Delta Guard reports as weakening and routes to the `governance-review` Environment. That is expected and requires owner approval.

## Supersession rule

Do not reintroduce an in-process model call in `apps/agent` to "simplify" a flow. If the control plane needs reasoning, it submits an InvestigationContext to the external runtime.
