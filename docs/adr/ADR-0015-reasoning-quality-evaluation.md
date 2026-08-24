# ADR-0015: Reasoning quality evaluation

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How Pi-Ops scores a ReasoningResult before it can become a MemoryCandidate
- **Supersedes**: none
- **Related**: ADR-0006, ADR-0009
- **Note**: ADR-0014 already documents delegation lifecycle

## Context

FakeReasoner, PiReasoner, and DelegatedReasoningResult all produce a ReasoningResult. That output is a hypothesis, not a trusted fact. If MemoryCandidate were created from the result alone, unreviewed or poorly evidenced diagnoses would enter the knowledge pipeline.

## Decision

Reasoning output is not automatically trusted.

```text
ReasoningResult
  → ReasoningEvaluation (confidenceScore, evidenceCoverageScore)
  → MemoryCandidate (only if both scores meet the threshold)
```

An evaluation records `evaluatorType`, `confidenceScore`, and `evidenceCoverageScore` in `[0, 1]`. The overall `score` is `min(confidenceScore, evidenceCoverageScore)`.

A MemoryCandidate must cite `sourceEvaluationId`. Inserts without an evaluation are rejected. Incident, Evidence, and ReasoningResult rows are never updated by evaluation.

The same service evaluates local (`fake` / `pi`) and delegated results.

## Consequences

Benefits:

- low-coverage or low-confidence reasoning cannot mint candidates
- quality scores are explicit and append-only

Costs:

- operators (or a later automated evaluator) must score results before memory exists

## Supersession rule

Do not create MemoryCandidate rows that skip ReasoningEvaluation.
