# Pi-Ops documentation

The current implementation source of truth is:

1. `adr/ADR-0001-dual-source-node-agent-architecture.md`
2. `adr/ADR-0006-reasoning-memory-foundation.md`
3. `adr/ADR-0008-reasoning-strategy-boundary.md`
4. `plans/PLAN-0001-dual-source-v0.1-implementation.md`
5. `evolution/timeline.md`

The architecture intentionally separates:

- `pi-ops-agent`: event/incident/evidence/reasoning/notification/audit.
- `pi-ops-node-agent`: deterministic per-host observation and typed read-only evidence.
- `@pi-ops/protocol`: the one shared contract for events and evidence.

Implementation must proceed milestone-by-milestone. Do not skip ahead to Pi SDK integration before deterministic event, incident, and evidence flows are working.
