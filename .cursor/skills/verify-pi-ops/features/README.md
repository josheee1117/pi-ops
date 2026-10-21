# pi-ops verification map

This directory is the maintained source for verifying the user-visible behavior of pi-ops. Read the index, then use the matching feature file as the recipe.

## Baseline preconditions

- Stack started by this run with `$CTL up` (`CTL="node .cursor/skills/verify-pi-ops/scripts/control-pi-ops.mjs"`, from repo root).
- `$CTL doctor` returns `"ok": true` and `drillHealthy: true`.
- Tokens are the local compose defaults (`local-operator-token`, `local-node-token`, `local-runtime-token`).
- Never drive a stack this run did not start.

## Driving conventions

- Start every recipe from the baseline. Recipes that fail the drill end with `$CTL drill ok`.
- Use route paths and JSON fields as stable handles: `incident.state`, `sessions[0].status`, `notifications[].type`, `evidence[].kind`.
- Save each step with `$CTL save <run> <name> -- <command>`.

## Proof and skip reporting

- Proof is the command, its JSON, and its exit code, saved under `artifacts/verify-pi-ops/<run>/`.
- Mutations get a second read-only view (for example `incident <id>` after `drill ok`).
- Report an unreachable path with the attempted command and the unmet precondition. Do not report it as verified through another path.

## Features

- [Incident lifecycle](./incident-lifecycle.md): outage → OPEN incident → RECOVERED, deduped per service.
- [Investigation and evidence](./investigation-evidence.md): automatic investigation session, safe vs raw evidence views.
- [Notifications](./notifications.md): webhook delivery for open, investigation and recovery, with idempotency keys.
- [Node evidence query](./node-evidence.md): typed read-only evidence from a host.
- [Runtime bounds](./runtime-bounds.md): pi-runtime findings depend on the data, and oversized context is rejected.
