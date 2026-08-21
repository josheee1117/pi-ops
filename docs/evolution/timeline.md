# Pi-Ops evolution timeline

Milestone history for dual-source v0.1. Architecture remains ADR-0001 unless a later ADR supersedes it.

## Reasoning strategy boundary

- ReasoningJob executes through ReasoningStrategy (`deterministic` / `single_reasoner` / `delegated_analysis`)
- `delegated_analysis` is reserved for Pi Runtime; Pi-Ops does not orchestrate agents
- FakeReasoner and PiReasoner behavior unchanged

## M10.3 completed

- reasoning evaluation introduced (`reasoning_evaluations`, append-only)
- memory candidate foundation introduced (`memory_candidates`, default PENDING)
- historical knowledge pipeline started: complete ReasoningResult + high evaluation score → MemoryCandidate
- memory is not retrieved and is not injected into FakeReasoner or PiReasoner
