# Node evidence query

Each host's node-agent answers typed, read-only evidence queries. It is the only way pi-ops looks at a host.

## Sub-features

- `ne-memory`: `host.memory` returns `usedPercent`.
- `ne-load`: `host.load` returns load averages.
- `ne-auth`: a wrong token is rejected.

## How to get to it (user POV)

- `POST /v1/evidence/query` on the node-agent with the node bearer token.

## Driving it with control-pi-ops

Preconditions: baseline.

- **Memory:** `$CTL node-evidence host.memory` → `kind == "host.memory"`, `data.usedPercent` present.
- **Load:** `$CTL node-evidence host.load` → exit 0.
- **Auth:** `NODE_TOKEN=wrong $CTL node-evidence host.load` → exit 1, `status` 401.

## Gotchas

- Container evidence only works for names in `PI_OPS_ALLOWED_CONTAINERS` (locally just `pi-ops-drill`).
