# Feature map

pi-ops has no UI. A feature is reached through HTTP, observed through the operator API, and "proven" by a state transition plus the records it leaves behind.

Everything below is written against the local compose stack (`pnpm start:local` equivalent, driven by `scripts/drive.sh`). The JDK17 + WeCom overlay and the remote deployment are separate targets and are not covered by these files.

## Shared facts

| Thing | Value |
| --- | --- |
| Operator API | `http://127.0.0.1:18080`, `Authorization: Bearer local-operator-token` |
| Node agent | `http://127.0.0.1:18081`, `Authorization: Bearer local-node-token` |
| pi-runtime | `http://127.0.0.1:18090`, `Authorization: Bearer local-runtime-token` |
| Drill workload | `http://127.0.0.1:18088` (`/health`, `POST /fail`, `POST /ok`) |
| Webhook sink | `http://127.0.0.1:18099` (`/notifications`) |
| Tokens and wiring | `deploy/local/compose.env` |
| Evidence from a run | run directory under `~/.cache/verify-evidence/pi-ops/` |

The default stack reasons with the deterministic FAKE model and notifies the local sink. A run proves the chain, not model quality and not group delivery.

## Features

| Feature | File | What a user can tell apart |
| --- | --- | --- |
| Fault drill | [health-drill.md](health-drill.md) | injecting an unhealthy workload produces a `health.failure` Incident |
| Incident lifecycle | [incident-lifecycle.md](incident-lifecycle.md) | a failure window becomes exactly one Incident that reopens facts, then `RECOVERED` |
| Investigation and diagnosis | [diagnosis.md](diagnosis.md) | one investigation session returns a report with hypothesis, confidence, diagnosis and evidence citations |
| On-call notification | [oncall-notification.md](oncall-notification.md) | open and recovered messages reach the webhook, each job delivered once |
| Evidence and brief | [evidence-and-brief.md](evidence-and-brief.md) | the on-call brief exists, and safe vs raw evidence differ where they should |

## Coverage of the current driver

`drive.sh drill health` exercises all five in one pass, in that order. It does not exercise: continued-failure aggregation beyond one window, the dynamic evidence enrichment that runs when the model asks for more, the real-model path, the JDK17/DataAsset overlays, remote deployment, or real WeCom delivery.

## Adding a feature

Add one file with the same four sections, name the endpoint or command a real operator uses, and say what observable end state counts as passing. If a journey needs a precondition the seed data lacks, report it as a failure and record the reason under Gotchas. Do not weaken the journey to make it pass.
