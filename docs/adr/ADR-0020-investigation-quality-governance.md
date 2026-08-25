# ADR-0020: Investigation quality governance

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Evidence-backed hypotheses and quality scores before investigation memory
- **Supersedes**: none
- **Related**: ADR-0015, ADR-0017, ADR-0018, ADR-0019

## Context

ADR-0018/0019 persist an InvestigationReport and a ReasoningResult. A report can still be a single sentence with weak or contradictory evidence. If MemoryCandidate only required a human ReasoningEvaluation, a high-confidence but poorly evidenced investigation would enter the knowledge pipeline.

Investigation conclusions require evidence-backed quality evaluation.

Pi-Ops owns investigation lifecycle, evidence governance, quality evaluation, and provenance. Pi Runtime owns execution, tools, and reasoning generation.

## Decision

```text
InvestigationReport
  → InvestigationHypothesis (PROPOSED → SUPPORTED | REJECTED)
  → InvestigationQualityEvaluation
  → ReasoningEvaluation
  → MemoryCandidate
```

### Hypothesis

An InvestigationHypothesis records a statement, confidence, supporting and contradicting evidence ids, and status. Evidence ids must belong to the Incident. Completing a report proposes one hypothesis from the report text. Status changes do not rewrite Incident or Evidence.

### Quality

`InvestigationQualityEvaluation` scores:

- evidence coverage = supporting / incident evidence count
- contradiction ratio = contradicting / cited evidence
- confidence consistency = 1 − |stated confidence − expected confidence|

`qualityScore` is the mean of coverage, `1 − contradiction`, and consistency. Weak support lowers the score.

### ReasoningResult

The result cites `hypothesisIds` and `investigationQualityEvaluationId`. Incident and Evidence rows are never updated.

### Memory

For an investigation-loop result, a MemoryCandidate requires:

- ReasoningResult
- ReasoningEvaluation at the existing threshold
- InvestigationQualityEvaluation at the same threshold

Local FakeReasoner / PiReasoner results without a session stay on the ADR-0015 path.

## Consequences

Benefits:

- poorly evidenced reports cannot mint memory
- competing hypotheses remain explicit instead of being merged

Costs:

- operators must run quality evaluation before investigation memory exists

## Supersession rule

Do not create a MemoryCandidate from an investigation result without InvestigationQualityEvaluation.
