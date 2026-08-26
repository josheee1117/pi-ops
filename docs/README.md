# Pi-Ops documentation

The current implementation source of truth is:

1. `adr/ADR-0001-dual-source-node-agent-architecture.md`
2. `adr/ADR-0006-reasoning-memory-foundation.md`
3. `adr/ADR-0008-reasoning-strategy-boundary.md`
4. `adr/ADR-0009-memory-governance.md`
5. `adr/ADR-0010-memory-retrieval-boundary.md`
6. `adr/ADR-0011-reasoning-delegation-boundary.md`
7. `adr/ADR-0012-pi-runtime-delegation-contract.md`
8. `adr/ADR-0013-delegated-result-ingestion.md`
9. `adr/ADR-0014-delegation-lifecycle.md`
10. `adr/ADR-0015-reasoning-quality-evaluation.md`
11. `adr/ADR-0016-memory-feedback-loop.md`
12. `adr/ADR-0017-memory-intelligence-phase.md`
13. `adr/ADR-0018-pi-runtime-investigation-loop.md`
14. `adr/ADR-0019-pi-runtime-production-contract.md`
15. `adr/ADR-0020-investigation-quality-governance.md`
16. `adr/ADR-0021-investigation-knowledge-graph.md`
17. `adr/ADR-0022-evidence-intelligence.md`
18. `adr/ADR-0023-investigation-knowledge-graph.md`
19. `adr/ADR-0024-operational-knowledge-retrieval.md`
20. `adr/ADR-0025-external-bounded-multi-agent-runtime.md`
21. `plans/PLAN-0001-dual-source-v0.1-implementation.md`
22. `evolution/timeline.md`

The architecture intentionally separates:

- `pi-ops-agent`: event/incident/evidence/reasoning/notification/audit.
- `pi-ops-node-agent`: deterministic per-host observation and typed read-only evidence.
- `pi-runtime`: external bounded coordinator/specialist investigation.
- `@pi-ops/protocol`: the one shared contract for events, evidence, and the investigation runtime.

Implementation must proceed milestone-by-milestone. Do not skip ahead to Pi SDK integration before deterministic event, incident, and evidence flows are working.
