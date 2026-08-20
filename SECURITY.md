# Security boundary

Pi-Ops v0.1 is observation-first and read-only.

Never commit secrets. Runtime credentials belong in environment/server secret configuration.

The node agent must not expose an arbitrary shell or generic command endpoint. Evidence capabilities must be typed, allowlisted and bounded by timeout/size/target restrictions.

Direct Docker socket access is root-equivalent capability on the host. If used during MVP, treat it as a documented technical debt and expose only read-only typed APIs from the node agent. A later Host Ops/Docker proxy can narrow the underlying privilege further.

Any future write/remediation capability requires a new ADR and explicit policy/approval/audit design.
