# ADR-0006: Reasoning evaluation and memory foundation

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How Pi-Ops records whether a ReasoningResult was useful, and how reusable operational knowledge is proposed without changing live reasoning
- **Supersedes**: none
- **Related**: ADR-0001

## Context

M10.1/M10.2 persist a ReasoningResult after Incident + Evidence. That output is a hypothesis about one episode. It is not yet operational knowledge.

If PiReasoner later consumed every past hypothesis as context, three failures would follow:

1. Unreviewed model text would become policy.
2. A wrong diagnosis would reinforce itself on the next similar Incident.
3. Incident/Evidence facts would mix with inferred memory, breaking the collector-vs-reasoner boundary.

Pi-Ops therefore needs a place to learn from history without trusting that history yet.

## Decision

Memory is a separate, evaluated pipeline. It does not write into Incident, Evidence, or the live Reasoner context.

```text
Incident
  ↓
Evidence
  ↓
ReasoningResult          facts vs hypotheses stay distinct
  ↓
ReasoningEvaluation      append-only human/operator judgement
  ↓
MemoryCandidate          PENDING until explicitly approved
```

### Evaluation is required

A ReasoningResult is not evidence that the diagnosis was right. Only an independent evaluation records usefulness/correctness.

Evaluations are append-only. Multiple scores may coexist for one result. Old rows are never overwritten.

A MemoryCandidate is generated only when:

- the ReasoningResult status is `complete`
- the evaluation score is at or above the configured threshold (default 0.8)

Low-score or incomplete reasoning produces no candidate.

### Memory is not trusted

Candidates start as `PENDING`. Approval/rejection is explicit. This milestone does not auto-approve, retrieve, or inject candidates.

Every candidate points at `source_reasoning_result_id`. From that row the audit chain is:

```text
MemoryCandidate
  → ReasoningResult
  → ReasoningJob (when present)
  → Incident
  → Evidence snapshot (ids + hash)
```

### Memory is not injected into Pi

PiReasoner and FakeReasoner continue to see only the current Incident + bounded Evidence. Prompts, IncidentContext construction, and ReasoningResult persistence are unchanged.

Future retrieval (`Memory → PiReasoner`) requires a later ADR covering ranking, approval gates, and prompt isolation.

## Consequences

Benefits:

- historical feedback can accumulate without mutating facts
- wrong hypotheses cannot silently poison the next reasoning turn
- provenance remains auditable before any future prompt augmentation

Costs:

- knowledge is inert until a later retrieval milestone
- operators must evaluate results for candidates to appear

## Supersession rule

Do not inject MemoryCandidate text into PiReasoner, FakeReasoner, or IncidentContext without a new ADR.
