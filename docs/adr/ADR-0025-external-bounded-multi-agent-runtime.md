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

`InvestigationSession` is the attempt boundary. One session owns exactly one ReasoningJob (`rj-inv-${sessionId}`), InvestigationPlan, DelegationTask, runtimeRequestId, RuntimeTask, InvestigationReport, and ReasoningResult.

The attempt graph is created in one store transaction, so a partial attempt cannot survive a failed insert.

Open sessions with the same Incident + `EvidenceJob.generation` are reused. COMPLETED or FAILED sessions do not block a new *operator* attempt. Durable reconciliation treats one completed Investigation per Evidence generation as satisfied.

`EvidenceJob.generation` starts at 1 and increments only when deterministic Evidence is requeued (escalation / expiry). Dynamic Investigation Evidence (`inv-${sessionId}-...`) belongs to that generation and must not start another generation. `runtimeRequestId` is `rreq-${sessionId}`.

SUBMITTED/RUNNING sessions older than `PI_OPS_INVESTIGATION_STALE_TIMEOUT_MS` fail through InvestigationLoop and may retry within `PI_OPS_INVESTIGATION_RETRY_MAX_ATTEMPTS`.

External Runtime settings are all-or-none: URL, token, and callback URL are all set, or none are set.

Terminal state is consistent per attempt: a failed session fails its DelegationTask and its ReasoningJob. No attempt may change another attempt's lifecycle.

`reasoning_jobs.incident_id` is not unique. Each InvestigationSession has at most one ReasoningResult. Opening a store fails closed if legacy `reasoning_results` rows share a non-null `reasoning_job_id`.

Pi Runtime receives a canonical InvestigationContext:

```text
schemaVersion, incident, evidence, historicalKnowledge, historicalKnowledgeStatus, conflictingMemories
```

Legacy top-level history fields are not sent and are stripped if present. `factsOnlyContext` contains only schemaVersion, incident, and evidence.

### Ownership

Pi-Ops owns facts, Evidence, lifecycle, governance, and retrieval.

Pi Runtime owns the coordinator, specialist delegation, model execution, and synthesis.

`apps/agent` does not add AgentManager, Planner, or sub-agent implementations.

### Transport and delivery

Submit is `POST /v1/investigations`. Duplicate `runtimeRequestId` returns the same `runtimeTaskId`. Callbacks authenticate with a dedicated runtime token and only to the configured Pi-Ops URL.

Execution and delivery are separate SQLite statuses. `DELIVERING` is uncertain: a crash retries the callback (at-least-once). Pi-Ops callbacks are idempotent. Lost delivery is not acceptable.

### Deadlines

HTTP submit timeout, model execution timeout, and callback timeout are separate. Execution uses an orchestration `withDeadline` Promise race plus AbortController. A late model result cannot overwrite an already-failed RuntimeTask. Evidence enrichment shares that same deadline.

### Knowledge vs Evidence

Current Evidence and historical operational knowledge are labeled separately. Retrieval failure stays non-blocking and sets `historicalKnowledgeStatus=unavailable`.

Coordinator and specialists depend on an injected `RuntimeModel`. CI uses a deterministic fake model with zero network calls. Production with `PI_OPS_PI_PROVIDER` and `PI_OPS_PI_MODEL` uses `createAgentSession({ noTools: 'all' })`.

## Consequences

Benefits:

- the same Incident can be re-investigated after completion or failure without rewriting the previous attempt
- completed reports survive callback crashes
- non-cooperative models cannot hang the runtime

Costs:

- HTTP runtime is a separate process to operate
- specialist selection is heuristic and capped

## Supersession rule

Do not implement coordinator/specialist graphs inside `apps/agent`, and do not grant Pi Runtime shell or mutation tools.
