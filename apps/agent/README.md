# pi-ops-agent

Central Pi-Ops control/reasoning service.

Owns event ingress, persistence, incident lifecycle, evidence orchestration, PiReasoner integration, notification and audit.

Does not own raw host collection and must not expose arbitrary shell execution.

Implementation starts from `docs/plans/PLAN-0001-dual-source-v0.1-implementation.md`.
