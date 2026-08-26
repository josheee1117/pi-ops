# ADR-0025: External Pi Runtime and bounded multi-agent investigation

- **Status**: Accepted
- **Date**: 2026-08-26
- **Scope**: How Pi-Ops submits a frozen InvestigationContext to an external Pi Runtime that may run a bounded coordinator/specialist investigation
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0018, ADR-0019, ADR-0024, ADR-0026

## Context

ADR-0008 forbids agent orchestration inside `apps/agent`. ADR-0018/0019 define an asynchronous InvestigationSession and callback. Historical knowledge is retrieved as context (ADR-0024) and must not be treated as current Evidence.

Pi-Ops remains the control plane. Pi Runtime owns coordinator execution, specialist delegation, model calls, and synthesis.

## Decision

```text
Pi-Ops
  | immutable InvestigationContext + historicalKnowledgeStatus
  v
HttpPiRuntimeClient
  v
apps/pi-runtime (external)
  | Coordinator (max 3 allowlisted specialists)
  | JVM / Database / Container-Host / Application
  v
InvestigationRuntimeResult callback
  v
Pi-Ops governance (InvestigationReport → ReasoningResult)
```

### Investigation attempts

`InvestigationSession` is the attempt boundary. One session owns exactly one ReasoningJob, InvestigationPlan, DelegationTask, runtimeRequestId, RuntimeTask, InvestigationReport, and ReasoningResult.

Open sessions with the same Incident + contextSnapshotHash are reused. COMPLETED or FAILED sessions do not block a new attempt. `runtimeRequestId` is `rreq-${sessionId}` so a new attempt is a new runtime identity even when the context hash matches.

### Ownership

Pi-Ops owns facts, Evidence, lifecycle, governance, and retrieval.

Pi Runtime owns the coordinator, specialist delegation, model execution, and synthesis.

`apps/agent` does not add AgentManager, Planner, or sub-agent implementations.

### Transport and delivery

Submit is `POST /v1/investigations`. Duplicate `runtimeRequestId` returns the same `runtimeTaskId`. Callbacks authenticate with a dedicated runtime token and only to the configured Pi-Ops URL.

Execution and delivery are separate SQLite statuses. `DELIVERING` is uncertain: a crash retries the callback (at-least-once). Pi-Ops callbacks are idempotent. Lost delivery is not acceptable.

### Deadlines

HTTP submit timeout, model execution timeout, and callback timeout are separate. Execution uses an orchestration `withDeadline` Promise race plus AbortController. A late model result cannot overwrite an already-failed RuntimeTask.

### Knowledge vs Evidence

Current Evidence and historical operational knowledge are labeled separately. Retrieval failure stays non-blocking and sets `historicalKnowledgeStatus=unavailable`.

Coordinator and specialists depend on an injected `RuntimeModel`. CI uses a deterministic fake model with zero network calls. Production with `PI_OPS_PI_PROVIDER` and `PI_OPS_PI_MODEL` uses `createAgentSession({ noTools: 'all' })`.

## Consequences

Benefits:

- the same Incident can be re-investigated after completion or failure
- completed reports survive callback crashes
- non-cooperative models cannot hang the runtime

Costs:

- HTTP runtime is a separate process to operate
- specialist selection is heuristic and capped

## Supersession rule

Do not implement coordinator/specialist graphs inside `apps/agent`, and do not grant Pi Runtime shell or mutation tools.
