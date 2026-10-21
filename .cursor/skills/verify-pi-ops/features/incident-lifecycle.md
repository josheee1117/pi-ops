# Incident lifecycle

When a monitored service's health check starts failing, the node-agent reports it and pi-ops opens one incident for that node and service. When health returns, the incident moves to RECOVERED.

## Sub-features

- `il-open`: failing health opens a `health.failure` incident in state OPEN.
- `il-dedupe`: repeated failures of the same service don't open a second OPEN incident.
- `il-recover`: restored health moves the incident to RECOVERED.
- `il-persist`: the incident survives a pi-ops restart.

## How to get to it (user POV)

- A managed service goes down (here: `pi-ops-drill`).
- The operator lists incidents: `GET /v1/ops/incidents`, then opens one: `GET /v1/ops/incidents/:id`.

## Driving it with control-pi-ops

Preconditions: baseline, drill healthy, no OPEN incident for `pi-ops-drill`.

- **Cause an outage:** `$CTL drill fail` → `{"drill":{"healthy":false}}`.
- **See the incident:** `$CTL wait-incident --state OPEN` → `incident.type == "health.failure"`, `service == "pi-ops-drill"`, `nodeId == "local-dev"`.
- **Dedupe:** wait 10s, `$CTL incidents` → exactly one OPEN `health.failure` for `pi-ops-drill`.
- **Recover:** `$CTL drill ok` then `$CTL wait-incident --state RECOVERED` → same `id`.
- **Persist:** `docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env restart pi-ops`, wait for `$CTL doctor`, then `$CTL incident <id>` still shows RECOVERED.

## Gotchas

- Detection is edge-triggered. If the drill was already failing at startup, flip it `ok` then `fail`.
- An event the node-agent couldn't push after 4 attempts is dropped (`event push failed after 4 attempts`). See the networking gotcha in SKILL.md.
