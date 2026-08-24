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
9. `plans/PLAN-0001-dual-source-v0.1-implementation.md`
10. `evolution/timeline.md`

The architecture intentionally separates:

- `pi-ops-agent`: event/incident/evidence/reasoning/notification/audit.
- `pi-ops-node-agent`: deterministic per-host observation and typed read-only evidence.
- `@pi-ops/protocol`: the one shared contract for events and evidence.

Implementation must proceed milestone-by-milestone. Do not skip ahead to Pi SDK integration before deterministic event, incident, and evidence flows are working.
