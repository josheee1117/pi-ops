---
name: verify-pi-ops
description: Drive the pi-ops local stack for real and prove the chain fault → Incident → diagnosis → notification. Use before claiming a change to event ingest, incident aggregation, investigations, notifications, or evidence works, and whenever a task asks for running-app evidence instead of unit tests.
---

# verify-pi-ops

pi-ops has no web UI. The surface is HTTP: a central agent, one node agent per host, a pi-runtime that reasons, a disposable HTTP drill workload, and a webhook sink that stands in for the WeCom group. This skill drives that local compose stack and leaves evidence outside the repo.

One health fault on the drill container walks the whole chain: node agent probe → `health.failure` Incident → one investigation session in pi-runtime → report back to the center → `INCIDENT_OPEN` and `INCIDENT_RECOVERED` delivered to the local sink.

What this does not prove: model quality (the default stack runs a deterministic FAKE model), delivery to a real WeCom group, remote deployment, or the JDK17/DataAsset overlays. See Gotchas before claiming otherwise.

Every command prints one JSON object per line on stdout and exits non-zero on failure.

## Launch

Run from the repo root:

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh launch
```

- Builds the images, starts five services, and waits for readiness: `/health` on pi-ops, pi-runtime, node agent, drill and sink, plus `/ready` on pi-runtime and an authorized operator API call. A cold `--build` takes about 3 to 4 minutes; a warm launch about 20 seconds.
- Data isolation: it moves `deploy/local/data/{pi-ops,pi-runtime}` into the run directory and starts from empty SQLite files, so incidents from earlier sessions cannot be mistaken for this run. `cleanup` moves the old files back.
- Ports: 18080 pi-ops, 18081 node agent, 18090 pi-runtime, 18088 drill, 18099 sink. Compose project `pi-ops-local`, container names fixed.
- Prerequisites: Docker (OrbStack is what the repo was last run on). The build happens inside Docker; the host only needs `docker`, `curl` and `python3`.
- Options: `--no-build` reuse existing images, `--keep-data` continue the previous database instead of isolating, `--dry-run` print the plan, `--reuse` keep the current run directory.

Stop the stack with `cleanup`, not by hand.

## Doctor

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh doctor
```

Read-only, safe to run any time something looks off. Exit code 0 means the instance is worth driving. It checks: Docker reachable; all five containers running; three health endpoints answering; the runtime's `modelMode` (FAKE or REAL); the operator token accepted; the node agent answering a `host.memory` evidence query; the sink reachable; `compose.env` still pointing the webhook at the local sink and not at a real group; the image newer than HEAD; how many files are dirty.

Most likely failures and what they mean:

| Check | Meaning | Fix |
| --- | --- | --- |
| `doctor.build` false | image older than the last commit that changed `apps/`, `packages/`, or the Docker build inputs: you would test old code | `drive.sh launch` (rebuilds) |
| `doctor.containers` absent | stack down or partially up | `drive.sh launch` |
| `doctor.notificationTarget` false | webhook no longer the local sink | stop, do not drill, fix `deploy/local/compose.env` |
| `doctor.reasoner` FAKE | deterministic model, chain only | expected for the default stack |

## Drive

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh drill health
```

Scenarios: `health` only. The JDK17/WeCom overlay is deliberately not wired in because it messages a real group.

The run takes about 10 to 30 seconds with the FAKE model and prints these steps:

| Step | What it did | What proves it worked |
| --- | --- | --- |
| `drill.start` | reset the drill to healthy, recorded sink baseline | `ok:true` |
| `drill.incident` | `POST /fail`, then polled the operator API | an OPEN `health.failure` Incident for `pi-ops-drill`/`local-dev`, first seen after the run started |
| `drill.investigation` | waited for the session the center submitted to pi-runtime | one `COMPLETED` session with a report: hypothesis, confidence, recommendation, diagnosis, supporting evidence ids, evidence audits |
| `drill.recovery` | `POST /ok`, waited for the state machine | incident state `RECOVERED` |
| `drill.notifications` | read the notification jobs | `INCIDENT_OPEN` and `INCIDENT_RECOVERED` both `DELIVERED`. `INVESTIGATION_COMPLETED` is conditional (ADR-0030), absence is reported, not failed |
| `drill.sink` | read the sink | one received item per job, `idempotencyKey` equals `notificationId` |
| `drill.notice` | read the on-call brief | the message summary (scene, what happened, severity, recovery steps) exists |
| `drill` | summary | `incidentId`, `sessionId`, `state`, duration |

Manual equivalents, if you need a single step:

```bash
curl -X POST http://127.0.0.1:18088/fail
curl -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents
curl -X POST http://127.0.0.1:18088/ok
```

## Evidence

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh evidence
```

Writes to the run directory printed by `launch`, normally `~/.cache/verify-evidence/pi-ops/<UTC timestamp>/`. `current` in that folder points at the latest run. Files: `incident-detail.json`, `incident-brief.md`, `evidence-safe.json`, `evidence-raw.json`, `notifications-sink.json`, `compose-ps.json`, `logs/<service>.log`, `data/` (SQLite copy), `run-meta.json` (model mode, branch, HEAD, dirty count), `doctor.json`, and a `README.md` index.

Proof standards for this repo:

- Exercise the real path: `/fail` on the workload, not a test-only endpoint that writes an Incident directly.
- Capture the action and the resulting state. A report from before your change, or an incident list without the state transition, is not proof.
- Check side effects next to the visible state: the sink received the job, the job's idempotency key matches, the session count is exactly one.
- The drill workload and the local sink are the only stand-ins. Do not mock the agent, the node agent or the runtime: those are the code under test.
- Say which model ran. `run-meta.json` `modelMode: FAKE` means the chain works, not that diagnoses are good.
- `DELIVERED` means the sink accepted the HTTP call. It does not mean a human saw a message, and the delivered body is not stored (see Gotchas).

## Cleanup

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh cleanup
```

Captures evidence, stops only this compose project's containers, and moves the pre-existing SQLite data back. Evidence stays in the run directory; `cleanup.json` records that zero containers remain. `--keep-data` leaves this run's database in place and does not restore the old one. `--dry-run` prints the plan.

Never kill by process name and never use `docker system prune` here: other projects on this machine own their own containers and ports.

## Helpers

`scripts/drive.sh` is the only helper. Subcommands: `launch`, `doctor`, `drill health`, `evidence`, `cleanup`, `runs`, `help`. Every mutating subcommand accepts `--dry-run` where it makes sense.

Overridable environment, for driving a stack started with other ports or tokens: `PI_OPS`, `NODE_URL`, `RUNTIME_URL`, `DRILL`, `SINK`, `OPERATOR`, `NODE_TOKEN`, `RUNTIME_TOKEN`, `EXPECT_NODE_ID`, `PI_OPS_VERIFY_EVIDENCE_ROOT`. Defaults mirror `deploy/local/compose.env`.

## Gotchas

- **FAKE model by default.** `deploy/local/compose.env` has `PI_OPS_REASONER_TYPE=fake` and pi-runtime starts without credentials, so it runs `createFakeRuntimeModel`. The hypothesis you will see ("memory pressure observed") is generated text, not a diagnosis. Real-model evidence needs a real provider and owner authorization through the JDK17 or `real-pi` overlays, which this skill does not drive.
- **The sink stores metadata only.** `deploy/local/sink/server.mjs` keeps `notificationId`, `type`, `receivedAt` and the idempotency key, and drops the body. Content proof comes from `GET /v1/ops/incidents/:id/brief?format=markdown`, which uses the same `plainSummary` the WeCom body is built from. Do not claim you inspected the delivered bytes.
- **ADR-0030 changes what a notification run should expect.** Completing an investigation is not itself a notification; a diagnosis update is sent only for a structured repair action or a new impact fact. `deploy/local/smoke.sh` still asserts three notification types, which is older than this rule. If smoke fails on the missing `INVESTIGATION_COMPLETED`, that is a finding about the smoke, not about the chain. Do not weaken the reminder here or edit business code to make smoke pass.
- **No real WeCom traffic.** `compose.env` points the webhook at `notification-sink`. `drive.sh doctor` fails if that changes. The JDK17 overlay (`deploy/local/.env.jdk17`, `smoke-jdk17.sh`, `fault-drills.py`) needs real credentials, overlaps these ports, and sends to the configured robot: never run it as part of this skill.
- **One stack at a time.** Ports and two container names are fixed. Another session editing this repo may want the same stack; ask it before `launch`.
- **`pnpm start:local` is the foreground equivalent** of `launch` and does not isolate data. It is fine for a human, not for a verification run.
- **Secrets.** `deploy/local/.env*` and `apps/pi-runtime/src/benchmark/results/**/auth.json` are gitignored credentials. Never read `auth.json`, never paste `.env` values into evidence or a commit.
- **SQLite copies are best effort.** `data/` is copied while containers run, so it can be mid-write. The API JSON is authoritative for what the run saw.
- **Keep this file honest.** When an endpoint, port, config default or feature here stops matching the code, fix the skill in the same change. `/maintain-verification-skill` is the scheduled pass over this map.
