# pi-ops-node-agent

Per-host deterministic observer.

Owns Docker/host/health observation and typed read-only evidence queries. It is not an LLM agent and must not expose arbitrary shell execution.

v0.1 write operations such as restart/kill/redeploy/file write/DB write are out of scope.

Implementation starts from `docs/plans/PLAN-0001-dual-source-v0.1-implementation.md`.
