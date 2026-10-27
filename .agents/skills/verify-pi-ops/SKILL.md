---
name: verify-pi-ops
description: Drive the pi-ops local stack for real and prove the chain fault → Incident → diagnosis → notification. Use before claiming a change to event ingest, incident aggregation, investigations, notifications, or evidence works, and whenever a task asks for running-app evidence instead of unit tests.
---

# verify-pi-ops

pi-ops has no web UI. The surface is HTTP: a central agent, one node agent per host, a pi-runtime that reasons, a disposable HTTP drill workload, and a webhook sink that stands in for the WeCom group. This skill drives that local compose stack and leaves evidence outside the repo.

One health fault on the drill container walks the whole chain: node agent probe → `health.failure` Incident → one investigation session in pi-runtime → report back to the center → `INCIDENT_OPEN` and `INCIDENT_RECOVERED` delivered to the local sink.

The default stack uses a deterministic FAKE model and a local sink. The opt-in `drill real` scenario is the only path that uses a real provider and the pinned WeCom test robot, for two cases (`W2`, `B3`). Neither path proves a broader case matrix, a remote deployment, or the JDK17/DataAsset overlays, and `DELIVERED` never proves a human saw the message. See Gotchas before claiming otherwise.

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

Scenarios: `health` and `real`. `health` uses the local stack and the FAKE model. `real` is the opt-in real-model and WeCom path described in the next section.

The `health` run takes about 10 to 30 seconds with the FAKE model and prints these steps:

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

## Real drill (opt-in: real model, real WeCom test robot)

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh drill real
.agents/skills/verify-pi-ops/scripts/drive.sh drill real --cases W2 --execute
# Inspect W2's result before running B3.
.agents/skills/verify-pi-ops/scripts/drive.sh drill real --cases B3 --execute
```

Run one case at a time. Continue to B3 only after W2 passes and its runtime log and session contain no provider 402/429/503. On any such response, stop and report without switching models or retrying. `fault-drills.py` does not stop a multi-case run after a failed session, so `--cases W2,B3 --execute` cannot enforce this gate.

This is the only scenario that talks to a real provider and a real WeCom robot. It does not start the `pi-ops-local` stack and does not use the local sink: it wraps `deploy/local/fault-drills.py`, which runs compose project `pi-ops-jdk17-local` with per-run data under `deploy/local/data/jdk17/`.

Before the sender starts, `fault-drills.py` renders the compose config, hashes `PI_OPS_NOTIFICATION_WEBHOOK_URL`, and compares it with the test-channel digest pinned in its source (`TEST_NOTIFICATION_URL_SHA256`). Anything but `match: true`, with a stopped central agent on a fresh database mount, aborts the case before any send. `drive.sh` never reads the URL. The receipts are written as `notification-target-rendered.json` and `notification-target-container.json` in the case artifacts and carry only the digest.

Without `--execute` it prints the plan and exits; it creates no evidence directory and starts nothing. It refuses any case other than `W2` and `B3`: another case needs owner authorization, an entry in `real_fault`/`real_expected_incident`, and a note in `features/diagnosis.md`.

Preflight, all fatal if not met:

- no container running in project `pi-ops-local` or `pi-ops-jdk17-local`
- host ports 18080, 18081, 18089, 18090 free, with the holding process named (a foreign listener blocks the compose up)
- `deploy/local/{.env,.env.jdk17,.env.jdk17-models.json}` present
- the model named by `PI_OPS_JDK17_MODEL` (default `gpt-5.6-sol`) listed in `.env.jdk17-models.json`

| Case | Injected fault | Expected Incident | Recovery |
| --- | --- | --- | --- |
| W2 | `POST /heap`: retain memory until `OutOfMemoryError: Java heap space` (Xmx128m, 512m container) | `jvm.oom` | none: no recovery mapping, the Incident stays OPEN |
| B3 | `POST /exit-nonzero`: the JVM exits with status 17, `restart: no` | `container.die` | none for the same reason |

B3 is a record-only case. Policy decides `record / container-exit-without-oom`, so neither a session nor a message is expected: `fault-drills.py` settles as soon as the evidence jobs finish, writes `diagnosis: NOT_EXPECTED` with the decision's `action`/`reason`, and passes `notification` only when nothing was sent.

One line per case after the run:

| Field | Meaning |
| --- | --- |
| `incidentTypes`, `incidentStates` | what the center opened |
| `sessions[]` | status, confidence, hypothesis, supporting evidence id count, whether the report carried a structured `diagnosis` and its action purposes |
| `notificationDecisions` | per Incident `action`, `reason`, and whether a session is expected at all |
| `evidenceKinds` | JFR, inspect, logs, stats, host memory |
| `notifications`, `notificationJobRows` | one job per type with `status`, `attempts`, `lastError` from the jobs table |
| `notificationTarget` | both receipts, `match: true` required |
| `checks`, `ok` | expected type, session and message outcome matching `notificationDecisions` (a record-only case expects zero of both), both receipts pinned, no execution error |

`ok` means the chain ran and, for a notifying case, the robot accepted every message. It does not mean the diagnosis is right: compare `hypothesis` and `supportingEvidenceIds` with the injected fault by hand, as `features/diagnosis.md` describes. For a record-only case `ok` means the decision, the missing session and the empty queue agreed.

Evidence is copied out of the repo into `~/.cache/verify-evidence/pi-ops/<timestamp>-real/real/<case>-<runId>/`: case artifacts without JFR binaries and SQLite dumps, plus `notification-jobs.json` with the job columns only. `source-group.txt` points at the original group under `deploy/local/data/fault-drills/`. Whatever the outcome, the stack is stopped with `docker compose -p pi-ops-jdk17-local down --remove-orphans` and `drill.real.stack` records the container count left behind.

What it proves: a real provider produced the report, and the pinned test robot returned `errcode=0` for every job of that case. For B3 it proves the other outcome: policy decided neither to investigate nor to notify, and nothing was sent. What it does not prove: that a human saw the message (the delivered body is not stored), anything about other cases or repeat stability, recovery (W2 and B3 never recover), or the remote deployment.

## Evidence

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh evidence
```

Writes to the run directory printed by `launch`, normally `~/.cache/verify-evidence/pi-ops/<UTC timestamp>/`. `current` in that folder points at the latest run. Real-drill directories are named `<timestamp>-real` and `current` keeps pointing at the last launched local run. Files: `incident-detail.json`, `incident-brief.md`, `evidence-safe.json`, `evidence-raw.json`, `notifications-sink.json`, `compose-ps.json`, `logs/<service>.log`, `data/` (SQLite copy), `run-meta.json` (model mode, branch, HEAD, dirty count), `doctor.json`, and a `README.md` index.

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

`scripts/drive.sh` is the only helper. Subcommands: `launch`, `doctor`, `drill health`, `drill real`, `evidence`, `cleanup`, `runs`, `help`. Every mutating subcommand accepts `--dry-run` where it makes sense.

Overridable environment, for driving a stack started with other ports or tokens: `PI_OPS`, `NODE_URL`, `RUNTIME_URL`, `DRILL`, `SINK`, `OPERATOR`, `NODE_TOKEN`, `RUNTIME_TOKEN`, `EXPECT_NODE_ID`, `PI_OPS_VERIFY_EVIDENCE_ROOT`. Defaults mirror `deploy/local/compose.env`.

## Gotchas

- **FAKE model by default.** `deploy/local/compose.env` has `PI_OPS_REASONER_TYPE=fake` and pi-runtime starts without credentials, so it runs `createFakeRuntimeModel`. The hypothesis you will see ("memory pressure observed") is generated text, not a diagnosis. Use `drill real` for real-model evidence; it needs the gitignored credentials and the owner's authorization.
- **A foreign listener on 18089 blocks the real drill.** 2026-10-22: an orphan `data-asset-starter` JVM from another worktree had held `*:18089` for a week, and `docker run -p 127.0.0.1:18089:8088` failed with `Bind for 0.0.0.0:18089 failed: port is already allocated`. `drive.sh drill real` now dies in the preflight and names the process. Freeing that port is the owner's call: it is not a pi-ops container, and this skill only ever stops compose project `pi-ops-jdk17-local`.
- **B3 stops at policy, before the model, and that is the expected outcome.** On 2026-10-22 at HEAD `083ff53`, the process exited 17 and inspect/logs succeeded, but `notificationDecision` was `record` with reason `container-exit-without-oom`. `apps/agent/src/investigation-reconciler.ts` starts a session only for `analyze`/`alert` (or a missing `health-binding`) on non-recovered incidents, while notification policy sends nothing for `record`. `fault-drills.py` used to wait 330s for a session that policy would never create and then failed the case; it now settles on evidence jobs and judges `diagnosis: NOT_EXPECTED` with `notification: PASS` while zero messages went out. A message in a record-only case is still a failure. Do not change business policy to make a case pass.
- **One W2 action can produce two Incidents.** The same 2026-10-22 run produced one `jvm.oom` for `order-service-本地演练-<runId>` and another for `order-local-drill-<runId>`. Both cited the same container and OOME, completed diagnosis, and sent an `INCIDENT_OPEN`. Compare service names and evidence before treating them as two independent faults. The driver's `ok` does not check duplicate Incidents.
- **The real drill builds images from the working tree.** `fault-drills.py --build` always runs, so uncommitted files are baked into the image. `dirtyFiles` in the first line and `real/git-dirty.txt` say what was included; another session's work in `apps/agent` can change the brief text you see.
- **Uncommitted TypeScript errors block docker image builds.** When uncommitted code in `apps/` fails `pnpm build`, cold `drive.sh launch` (which runs `--build`) fails during the Docker image build. `drive.sh launch --no-build` allows exercising the runtime chain against the last built local images, but `drive.sh doctor` reports `doctor.build: false` until the workspace compiles and images can be rebuilt.
- **No receipt, no proof.** A real-drill case fails unless both `notification-target-*` receipts exist with `match: true`. Groups from before those receipts existed (for example 2026-10-03) fail closed, even when the jobs say `DELIVERED`.
- **The local sink is a different path.** `drill real` never posts to `notification-sink`, so sink history (hundreds of items in a long-lived checkout) says nothing about real delivery. Read `notifications` and `notificationJobRows` for the real case.
- **The sink stores metadata only.** `deploy/local/sink/server.mjs` keeps `notificationId`, `type`, `receivedAt` and the idempotency key, and drops the body. Content proof comes from `GET /v1/ops/incidents/:id/brief?format=markdown`, which uses the same `plainSummary` the WeCom body is built from. Do not claim you inspected the delivered bytes.
- **ADR-0030 changes what a notification run should expect.** Completing an investigation is not itself a notification; a diagnosis update is sent only for a structured repair action or a new impact fact. `deploy/local/smoke.sh` asserts `INCIDENT_OPEN` and `INCIDENT_RECOVERED` and forbids `INVESTIGATION_COMPLETED` on the FAKE report, which carries no repair action. If smoke sees a diagnosis update there, the notify-on-completion behaviour is back: that is a finding about the chain, not about the smoke. Do not weaken the assertion or edit business code to make smoke pass.
- **No real WeCom traffic on the default stack.** `compose.env` points the webhook at `notification-sink`. `drive.sh doctor` fails if that changes. Only `drill real` uses the JDK17 overlay (`deploy/local/.env.jdk17`, `fault-drills.py`) and its pinned robot; never point `compose.env` at a real group to get notification evidence.
- **One stack at a time.** Ports and two container names are fixed. Another session editing this repo may want the same stack; ask it before `launch`.
- **`pnpm start:local` is the foreground equivalent** of `launch` and does not isolate data. It is fine for a human, not for a verification run.
- **Secrets.** `deploy/local/.env*` and `apps/pi-runtime/src/benchmark/results/**/auth.json` are gitignored credentials. Never read `auth.json`, never paste `.env` values into evidence or a commit.
- **SQLite copies are best effort.** `data/` is copied while containers run, so it can be mid-write. The API JSON is authoritative for what the run saw.
- **Keep this file honest.** When an endpoint, port, config default or feature here stops matching the code, fix the skill in the same change. `/maintain-verification-skill` is the scheduled pass over this map.
