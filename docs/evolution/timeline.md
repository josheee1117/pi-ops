# Pi-Ops evolution timeline

Milestone history for dual-source v0.1. Architecture remains ADR-0001 unless a later ADR supersedes it.

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
