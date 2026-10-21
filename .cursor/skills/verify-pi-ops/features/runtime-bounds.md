# Runtime bounds

pi-runtime runs investigations asynchronously. Its findings must come from the evidence it got, and context over the byte limit must be refused.

## Sub-features

- `rb-data`: memory 92% gives "memory pressure observed", 20% gives "memory pressure not observed".
- `rb-bound`: a 20 KB evidence blob fails with `context_too_large`.

## How to get to it (user POV)

- pi-ops posts `POST /v1/investigations` to the runtime. The operator sees the result on the incident. Directly: `GET /v1/tasks/:runtimeRequestId`.

## Driving it with control-pi-ops

Preconditions: baseline.

- **Data-dependent finding and bound:** run the `runtime data-dependent finding + bound` block of `deploy/local/smoke.sh` (or the whole `pnpm smoke:local`) → prints `runtime data bound ok memory pressure observed memory pressure not observed context_too_large`.

## Gotchas

- The control CLI has no `submit` command yet. This path goes through the smoke script.
