# ADR-0025: External Pi Runtime and bounded multi-agent investigation

- **Status**: Accepted
- **Date**: 2026-08-26
- **Scope**: How Pi-Ops submits a frozen InvestigationContext to an external Pi Runtime that may run a bounded coordinator/specialist investigation
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0018, ADR-0019, ADR-0024

## Context

ADR-0008 forbids agent orchestration inside `apps/agent`. ADR-0018/0019 define an asynchronous InvestigationSession and callback, but HTTP transport was still a no-op. Historical knowledge is now retrieved as context (ADR-0024) and must not be treated as current Evidence.

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

### Ownership

Pi-Ops owns facts, Evidence, lifecycle, governance, and retrieval.

Pi Runtime owns the coordinator, specialist delegation, model execution, and synthesis.

`apps/agent` does not add AgentManager, Planner, or sub-agent implementations.

### Transport

Submit is `POST /v1/investigations` with `schemaVersion`, `runtimeRequestId`, session identity, and the frozen context. Duplicate `runtimeRequestId` returns the same `runtimeTaskId` and does not start another investigation. Authentication is a bearer token from the environment. Timeouts are bounded. Secrets are not stored in source.

Completion uses `POST /v1/investigation-results` on Pi-Ops. Duplicate completed callbacks remain idempotent. A failed runtime task fails the InvestigationSession and does not mutate Incident, Evidence, or MemoryEntry.

### Bounded multi-agent

The coordinator selects at most three specialists from `{jvm, database, container_host, application_business}` based on InvestigationContext. One specialist failure does not fail the investigation if another completed finding remains. All specialists failing, or coordinator failure, fails the runtime task.

Specialists return `SpecialistFinding`. Only the coordinator emits `InvestigationReport`. There is no recursive unbounded spawning, no shell, and no remediation.

### Knowledge vs Evidence

Current Evidence and historical operational knowledge are labeled separately. Evidence describes the current incident. Historical knowledge is advisory and cannot override current Evidence. Conflicting history is surfaced, not merged. Retrieval failure stays non-blocking and sets `historicalKnowledgeStatus=unavailable`.

### Tools

Pi Runtime may request only the existing typed read-only evidence classes. Collection stays on Pi-Ops / Node Agent. This phase defines that allowlist; it does not add arbitrary tools.

Coordinator and specialists depend on an injected `RuntimeModel`. CI uses a deterministic fake model with zero network calls. Production with `PI_OPS_PI_PROVIDER` and `PI_OPS_PI_MODEL` uses `createAgentSession({ noTools: 'all' })` from `@earendil-works/pi-coding-agent` 0.84.x. Invalid specialist JSON or foreign Evidence ids fail only that specialist.

Runtime tasks persist in SQLite with separate `executionStatus` and `deliveryStatus`. A completed report is not lost if the callback fails; delivery retries with backoff and resumes after restart. Duplicate `runtimeRequestId` after execution does not rerun the model.

HTTP submit timeout, callback timeout, and model execution timeout are separate settings. If current Incident + Evidence alone exceed `maxContextBytes`, the task fails with `context_too_large` instead of truncating Evidence.

Callbacks authenticate with a dedicated runtime token (never the ingest token) and only to the configured Pi-Ops callback URL.

Runtime metadata (specialists, provider/model, tokens, latency) is persisted on Pi-Ops as an investigation runtime audit and copied onto the ReasoningResult.

## Consequences

Benefits:

- multi-agent investigation can run without leaking orchestration into Pi-Ops
- runtimeRequestId idempotency and fail-closed callbacks stay the production contract

Costs:

- HTTP runtime is a separate process to operate
- specialist selection is heuristic and capped

## Supersession rule

Do not implement coordinator/specialist graphs inside `apps/agent`, and do not grant Pi Runtime shell or mutation tools.
