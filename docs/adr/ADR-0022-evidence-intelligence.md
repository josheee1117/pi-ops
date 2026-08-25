# ADR-0022: Evidence intelligence

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How evidence quality, not count, weights investigation scoring
- **Supersedes**: none
- **Related**: ADR-0020, ADR-0021
- **Note**: ADR-0021 already documents the investigation knowledge graph

## Context

InvestigationQualityEvaluation treated every Evidence row as equal. A `docker.logs` snippet then counted the same as `docker.inspect`. Weak or failed collectors could inflate coverage and mint memory from noisy support.

Evidence quality is more important than evidence quantity.

## Decision

```text
Evidence
  → EvidenceProfile (category, reliability, diagnosticWeight)
  → EvidenceRelevanceScore (vs Hypothesis)
  → weighted InvestigationQualityEvaluation
```

### Profile

Each Evidence row may carry an `EvidenceProfile`:

- `primary_signal` — inspect / probe / stats
- `supporting_signal` — host memory / load / disk
- `weak_signal` — logs, unknown kinds, failed collection

`reliabilityScore` and `diagnosticWeight` are derived from kind + status. Failed evidence is always weak.

### Relevance

`EvidenceRelevanceScore` combines the hypothesis relationship (supporting / contradicting / none) with reliability and diagnostic weight. Uncited evidence has relevance 0.

### Quality

Coverage is `sum(supporting weights) / sum(all incident evidence weights)`, not a raw count ratio. Contradiction uses the same weights. A Hypothesis records `supportingContribution` and `contradictingContribution` at propose time.

Unknown evidence ids are rejected. Incident and Evidence content is not rewritten.

This milestone does not add embeddings or a vector store.

## Consequences

Benefits:

- high-value collectors move quality more than log noise
- hypothesis provenance includes how much each side contributed

Costs:

- kind-based weights are coarse; a later ADR may refine them

## Supersession rule

Do not score investigation quality by evidence count alone when profiles exist.
