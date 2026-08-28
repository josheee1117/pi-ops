# Pi-Ops evolution timeline

Milestone history for dual-source v0.1. Architecture remains ADR-0001 unless a later ADR supersedes it.

## Phase 12 real Pi verification command

- `pnpm smoke:pi` requires gitignored provider/model credentials and refuses FakeRuntimeModel
- ordinary `pnpm test` / `pnpm smoke:local` stay deterministic

## Phase 12A local deployment baseline

- Docker Compose topology: Pi-Ops, Pi Runtime, Node Agent, disposable `pi-ops-drill`, notification sink
- real process boundaries, durable SQLite volumes, local incident drill and dynamic Evidence round-trip
- not remote test-infra

## Phase 11 security closure

- one `toRuntimeSafeEvidence` projection for initial InvestigationContext and dynamic Runtime Evidence
- raw SQLite Evidence stays unsanitized; Pi Runtime only sees redacted/bounded model-safe Evidence

## Phase 11 production semantics closure

- Coordinator merges canonical collected Evidence, including `data`, before specialist rerun; facts over budget fail with `context_too_large`
- Notification delivery transitions are state-guarded; `notificationId` is the Idempotency-Key; job `createdAt` is scheduling time so replay delivers OPEN before RECOVERED

## Phase 11 completed

- IncidentContext prefers newer collectedAt at equal rank; typed enrichment stays session-scoped and is not suppressed by historical same-kind Evidence
- Pi Runtime receives canonical historicalKnowledge only; SUPPORTED hypotheses are not resolutions
- requestingRoles is required and part of InvestigationEvidenceAudit identity
- NotificationJob/Worker deliver INCIDENT_OPEN, INVESTIGATION_COMPLETED, and INCIDENT_RECOVERED durably without mutating facts

## Phase 10.3 completed

- a failed InvestigationSession now terminalizes its DelegationTask and ReasoningJob; attempts never touch each other
- attempt graph creation is one store transaction; legacy reasoning_jobs UNIQUE migration has a real regression test
- runtime evidence responses reuse the canonical Evidence schema and are bound to their exact request
- `resolveRuntimeEvidenceQuery` is the single trusted target resolver; `host.disk` left the runtime allowlist
- enrichment reuse is session-scoped, audits use UPSERT with immutable provenance
- deterministic cross-application E2E covers ingest → investigation → typed enrichment → report, plus enrichment-unavailable and runtime-unreachable paths

## Phase 10.2 completed

- InvestigationSession owns one ReasoningJob per attempt; incident_id on reasoning_jobs is no longer unique
- typed missingEvidence executes the resolved query exactly via collectQueriesForIncident
- InvestigationEvidenceAudit is durable; requestingRoles survive one collection / multiple specialist reruns
- DELIVERING callbacks retry after crash; hard execution deadline is orchestration-level

## Phase 10 completed

- External `apps/pi-runtime` runs a bounded coordinator and allowlisted specialists
- Pi-Ops submits frozen InvestigationContext over HTTP and governs the callback
- historical knowledge stays advisory; `historicalKnowledgeStatus` distinguishes empty history from retrieval failure
- CI uses a deterministic fake RuntimeModel; production uses `createAgentSession({ noTools: 'all' })`
- runtime tasks and callback outbox are durable SQLite; execution and delivery are separate statuses
- current Evidence over the byte budget fails with context_too_large; runtime metadata is persisted on Pi-Ops

## Phase 9 completed

- KnowledgeRetriever builds OperationalKnowledgeContext from similar incidents, hypotheses, resolutions, and memories
- ranking uses similarity, memory effectiveness, and investigation quality; evidence quality fills gaps
- each item keeps source incident, source relation, and confidence; low-quality memory is filtered
- historical knowledge is context, never a replacement for Evidence; retrieval failure does not block investigation

## Phase 8 completed

- InvestigationRelation inserts are idempotent and queryable by from/to/type
- similar incidents persist as SIMILAR_TO edges without embeddings
- InvestigationContext stays frozen; Incident/Evidence provenance is unchanged

## Evidence intelligence completed

- EvidenceProfile classifies primary / supporting / weak signals with reliability and diagnostic weight
- InvestigationQualityEvaluation uses weighted coverage instead of raw counts
- Hypothesis records supporting and contradicting evidence contribution

## Phase 7 completed

- InvestigationRelation links Hypothesis↔Evidence and Memory→ReasoningResult
- IncidentSimilarityService finds structural matches without embeddings
- InvestigationContext adds related incidents, historical resolutions, and similar hypotheses
- graph lookup failures degrade to empty history without blocking reasoning

## Phase 6 completed

- InvestigationHypothesis tracks PROPOSED → SUPPORTED / REJECTED with owned evidence ids
- InvestigationQualityEvaluation scores coverage, contradiction, and confidence consistency
- investigation-loop MemoryCandidate also requires a quality evaluation

## Phase 5 completed

- runtimeRequestId makes submit idempotent: one session, one DelegationTask, one runtime task
- InvestigationReportCallback validates request/task/session ownership, schemaVersion, and evidence
- timeout and runtime-unavailable recovery do not mutate Incident or Evidence
- ReasoningResult traces Incident, Evidence snapshot, InvestigationSession, and runtime task

## Phase 4 completed

- InvestigationSession snapshots InvestigationContext and tracks CREATED → COMPLETED/FAILED
- Pi Runtime returns InvestigationReport; Incident/Evidence stay immutable
- MemoryCandidate from this loop requires report + evaluation

## Phase 3 completed

- Memory quality (success/failed/usage/effectiveness) is derived from MemoryFeedback
- MemoryRetriever ranks by quality; conflicting conclusions are listed, not merged
- InvestigationContext is a frozen handoff for future Pi Runtime

## M16 completed

- MemoryFeedback records SUCCESS / FAILED / UNKNOWN against Memory + Incident + optional ReasoningResult
- MemoryEntry content is not rewritten; later evolution reads feedback history
- unknown memory is rejected; effectivenessScore stays in [0, 1]

## M15 completed

- ReasoningEvaluation records confidenceScore and evidenceCoverageScore
- MemoryCandidate requires an evaluation; both scores must meet the threshold
- same evaluation path works for FakeReasoner, PiReasoner, and delegated results

## M14 lifecycle

- DelegationTask tracks PENDING → SUBMITTED → COMPLETED without executing agents
- ingest requires plan + task; ReasoningResult records delegationTaskId
- ADR-0014 documents Pi-Ops owning delegation lifecycle

## M14 completed

- DelegatedReasoningResult ingest validates plan, job, confidence, and incident evidence ids
- WAITING_DELEGATION → ReasoningResult → COMPLETED
- duplicate ingest is idempotent; Incident/Evidence stay immutable

## M13 completed

- delegated_analysis persists InvestigationPlan and enters WAITING_DELEGATION
- PiRuntimeClient submit/poll is a replaceable contract with a no-op adapter
- delegated work is not marked FAILED; unknown strategies still fail closed

## M12 completed

- InvestigationPlan is the durable handoff for delegated_analysis
- delegated_analysis creates a plan only and fails closed; no Reasoner/agent execution
- ReasoningResult records strategy / strategyVersion provenance

## M11 completed

- MemoryRetriever selects bounded ACTIVE MemoryEntry by incident type, service, and pattern keywords
- usedMemoryEntryIds recorded on ReasoningResult; Reasoner still sees only Incident + Evidence
- retrieval failure or empty results do not fail Event / Incident / Evidence / ReasoningJob

## M10.4 completed

- MemoryGovernanceService approve/reject introduced
- approved MemoryCandidate becomes MemoryEntry (ACTIVE / DISABLED)
- rejected candidate creates no entry; candidate knowledge fields stay immutable
- memory is still not injected into FakeReasoner or PiReasoner

## Reasoning strategy boundary

- ReasoningJob executes through ReasoningStrategy (`deterministic` / `single_reasoner` / `delegated_analysis`)
- `delegated_analysis` is reserved for Pi Runtime; Pi-Ops does not orchestrate agents
- FakeReasoner and PiReasoner behavior unchanged

## M10.3 completed

- reasoning evaluation introduced (`reasoning_evaluations`, append-only)
- memory candidate foundation introduced (`memory_candidates`, default PENDING)
- historical knowledge pipeline started: complete ReasoningResult + high evaluation score → MemoryCandidate
- memory is not retrieved and is not injected into FakeReasoner or PiReasoner
