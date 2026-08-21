# Pi-Ops evolution timeline

Milestone history for dual-source v0.1. Architecture remains ADR-0001 unless a later ADR supersedes it.

## M10.3 completed

- reasoning evaluation introduced (`reasoning_evaluations`, append-only)
- memory candidate foundation introduced (`memory_candidates`, default PENDING)
- historical knowledge pipeline started: complete ReasoningResult + high evaluation score → MemoryCandidate
- memory is not retrieved and is not injected into FakeReasoner or PiReasoner
