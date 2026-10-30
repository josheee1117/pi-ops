---
name: verify-pi-ops
description: Launch and drive the pi-ops local Docker Compose stack (pi-ops agent, node-agent, pi-runtime, drill target, notification sink) over its HTTP APIs to prove incident, investigation, evidence and notification behavior end to end. Use after changing apps/agent, apps/node-agent, apps/pi-runtime, packages/protocol or deploy/local, or whenever you need proof that pi-ops works.
---

# Verify pi-ops

pi-ops has no UI. Its users are an operator (reads incidents over `/v1/ops/*` with a bearer token) and a managed host (node-agent pushes events). The primary surface is therefore HTTP. Drive it through `scripts/control-pi-ops.mjs`, which wraps the exact calls `deploy/local/smoke.sh` makes and prints JSON.

```bash
CTL="node .cursor/skills/verify-pi-ops/scripts/control-pi-ops.mjs"   # run from repo root
$CTL --help
```

Third-party boundaries are mocked by the compose stack itself: `pi-ops-drill` is the monitored service (flip its health), `notification-sink` stands in for the WeCom/generic webhook, and `PI_OPS_REASONER_TYPE=fake` replaces the LLM. No secrets or accounts are needed. Do not drive the real Pi model (`docker-compose.real-pi.yml`); it needs `PI_MODEL_API_KEY` from the user.

## Launch

Needs Docker with compose v2 and free ports 18080, 18081, 18088, 18090, 18099.

```bash
$CTL up --dry-run   # prints the plan, touches nothing
$CTL up             # down → wipe deploy/local/data → up -d --build → wait for doctor ok (≤180s)
```

Ready = `up` exits 0 with `"ok": true`, meaning all five containers run, every `/health` answers, and operator, node and runtime tokens are accepted. First build takes ~2 min. SQLite migrations run on start, and no seed data is needed: the drill service is the precondition.

Isolation: the stack uses a fixed compose project (`pi-ops-local`), a fixed `container_name: pi-ops-drill`, and fixed host ports. Two instances cannot run side by side. If `doctor` shows a stack you did not start, stop and ask; don't `up` over someone else's run.

## Doctor

```bash
$CTL doctor   # read-only; exit 1 + hint when not worth driving
```

Check `missingServices` is empty and every `checks` value is true. `drillHealthy` tells you whether the drill is currently failing.

## Drive

The core user journey, as the operator sees it:

```bash
$CTL drill fail                                  # outage on the monitored service
$CTL wait-incident --state OPEN                  # → incident.id
$CTL wait-session <id>                           # investigation COMPLETED (fake reasoner)
$CTL evidence <id> --view safe                   # model-safe evidence, secrets redacted
$CTL evidence <id> --view raw
$CTL drill ok
$CTL wait-incident --state RECOVERED
$CTL incident <id>                               # incident + sessions + notifications
$CTL notifications                               # what the webhook actually received
```

Per-feature recipes live in [`features/README.md`](features/README.md). For the full regression run use the repo's own `pnpm smoke:local` (it also restarts services to prove persistence).

## Evidence

Wrap any command with `save` to keep its JSON under `artifacts/verify-pi-ops/<run-id>/` (gitignored, kept by `down`):

```bash
RUN=$(date +%Y%m%d-%H%M%S)
$CTL save $RUN 01-doctor -- doctor
$CTL save $RUN 02-drill-fail -- drill fail
```

Proof standards:
- Capture the action and the resulting state: the `drill` call, then the incident in OPEN, then RECOVERED.
- Verify side effects, not just responses: the notification sink's received webhooks (`notifications`) and that idempotency keys equal notification IDs; persistence across `docker compose restart pi-ops` when you touched the store.
- Use the real operator and node paths. Don't insert rows into SQLite or call `/v1/investigation-results` yourself to fake progress.
- Mocks are allowed only at the existing boundaries above (drill, sink, fake reasoner).
- `--dry-run` on `up`/`down` was verified to only print: containers stayed up after `down --dry-run`.

## Cleanup

```bash
$CTL down --dry-run
$CTL down      # compose down --remove-orphans for project pi-ops-local + rm -rf deploy/local/data
ls artifacts/verify-pi-ops/$RUN   # proof must still be here
```

`down` only removes this compose project. Never `docker kill` by name or prune.

## Gotchas

- Containers healthy but no incident ever appears, and node-agent logs `event push failed ... aborted due to timeout`: container-to-container traffic is blocked on the host. On sandbox boxes with `br_netfilter`, `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` fixed it. Events dropped before the fix are gone; run `drill ok` then `drill fail` again.
- `deploy/local/data` is written as root by the containers, so a plain `rm -rf` can fail with EACCES. `up`/`down` fall back to deleting it from a throwaway container using the stack's sink image.
- `curl: (56) Recv failure` lines during smoke startup are the readiness poll and harmless.
- The health detector needs a state change. If the drill was already failing when the stack started, flip it `ok` then `fail`.
- `PI_OPS_REASONER_TYPE=pi` fails closed by design (ADR-0029). Only `fake` is drivable without credentials.

## Helpers

- `scripts/control-pi-ops.mjs`: zero-dependency Node ≥20 CLI. JSON on stdout, exit 0/1/2, `--dry-run` on `up` and `down`, `--help` for all commands and env overrides (`PI_OPS`, `OPERATOR`, … so it can point at a remote deployment, like `smoke.sh`'s `REMOTE` mode).

Keep the feature map honest with `/maintain-verification-skill`.
