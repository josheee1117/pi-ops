# On-call notification

The center decides whether and when to notify, builds a plain-language summary, and delivers it as a durable job. In the local stack the webhook target is `notification-sink`, which records what it received. ADR-0030 governs what should be sent.

## Sub-features

- Incident OPEN: a bound health target that is unavailable is notifiable without waiting for the model (ADR-0030 rule 1).
- Recovery: after the open message was delivered, the Incident sends one `INCIDENT_RECOVERED`. If recovery arrives before the first delivery, the first message becomes "曾发生、现已恢复" and no separate recovery is sent.
- Diagnosis update: `INVESTIGATION_COMPLETED` is sent only when the completed report adds a structured repair action or a new impact fact. Completing an investigation alone sends nothing (ADR-0030 rule 3).
- Decision record: `notificationDecision` on the Incident says which rule fired (`action`, `reason`, `facts`, `valueKeys`), so a missing message can be explained rather than guessed.
- Delivery bookkeeping: the operator API's `notifications[]` exposes `id`, `type`, `status`, `notificationId` and `createdAt`; `attempts`, `last_error` and `delivered_at` live in the `notification_jobs` table (the real drill exports those columns as `notification-jobs.json`). A 429/5xx is retryable, a 4xx is terminal.
- Idempotency: the HTTP call carries `Idempotency-Key` equal to `notificationId`; the sink records both.

## How to get to it (user POV)

The on-call engineer receives the message in WeCom in a real deployment. Locally the message goes to the sink, and the operator checks what was scheduled and what arrived:

```bash
curl -fsS -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents/<id>   # notifications[]
curl -fsS http://127.0.0.1:18099/notifications                                                          # what the sink got
curl -fsS -H 'Authorization: Bearer local-operator-token' 'http://127.0.0.1:18080/v1/ops/incidents/<id>/brief?format=markdown'
```

## Driving it with drive.sh

- `drill.notifications` requires `INCIDENT_OPEN` and `INCIDENT_RECOVERED` in status `DELIVERED`. It reports `INVESTIGATION_COMPLETED` separately as `diagnosisUpdate` with the ADR-0030 note, because absence is a policy outcome, not a failure.
- `drill.sink` requires one sink item per job and `idempotencyKey == notificationId`.
- `drill.notice` reads the on-call brief and prints the summary (`scene`, `whatHappened`, `severity`, `recovery`). That summary is the same `plainSummary` the WeCom markdown body is built from, so it is the content check available in this stack.
- `incident-detail.json` and `notifications-sink.json` keep the raw records for later review.

Passing end state: an open message and a recovery message, both `DELIVERED`, both present at the sink with matching idempotency keys, and the brief carrying a non-empty what-happened sentence. On this branch's quick-recover drill, `INVESTIGATION_COMPLETED` is normally absent because the FAKE report adds no repair action and no new impact fact.

## Real WeCom delivery (opt-in)

Follow the single-case commands and provider-error gate in `../SKILL.md`, under Real drill. Each command starts with a fresh database, so it never replays an earlier case's queue.

This is the only path in this skill that sends to a real WeCom robot, and it sends only to the channel whose SHA-256 is pinned in `deploy/local/fault-drills.py`. The overlay sets `PI_OPS_NOTIFICATION_WEBHOOK_KIND=wecom`, `PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS=1` and `PI_OPS_NOTIFICATION_JOB_BATCH_SIZE=1`: one message at a time, no retry, so a transient 45009 or 5xx shows up as a `FAILED` job instead of being papered over.

A job reaches `DELIVERED` only after the HTTP call returns 2xx and the body parses to `errcode: 0` (`apps/agent/src/notifier.ts`). Anything else throws before the status write. The raw WeCom response body and the delivered markdown are not persisted.

Evidence per case, in the copied artifacts:

| File | What it shows |
| --- | --- |
| `notification-target-rendered.json`, `notification-target-container.json` | `match: true` for the rendered and the created sender, plus `kind: wecom` and a fresh database mount |
| `artifacts/settled-<incident>-detail.json` | `notifications[]` per job |
| `notification-jobs.json` | `status`, `attempts`, `lastError`, `deliveredAt` per job |
| `artifacts/pi-ops.log` | the send attempt and any error text; the notifier never logs the URL |

`drive.sh` prints `notificationJobRows` so `attempts: 1` and `lastError: null` are visible next to `DELIVERED`. A case is not `ok` when either receipt is missing or not `match: true`.

What it proves: the center built the message, called the pinned robot, and WeCom answered `errcode=0` within the timeout. What it does not prove: that a human read it, that the group is the one the on-call engineer watches, or what the message looked like. The final check is a person looking at the test group.

## Gotchas

- **The sink stores metadata only.** `deploy/local/sink/server.mjs` keeps `receivedAt`, `idempotencyKey`, `notificationId`, `type` and discards the body. `DELIVERED` proves the sink accepted the call, not that a human saw a message. Never claim you inspected the delivered WeCom body here.
- **Never point `compose.env` at a real group.** It targets `notification-sink`; `drive.sh doctor` fails if that changes. The JDK17 overlay reads a real robot from the gitignored `.env.jdk17`; only `drill real` may use it.
- **Smoke follows ADR-0030.** `deploy/local/smoke.sh` requires `INCIDENT_OPEN` and `INCIDENT_RECOVERED`, and rejects `INVESTIGATION_COMPLETED` for the FAKE report. The real drill may send a diagnosis update for a structured repair action or a new impact fact. Read the report and `notificationDecision` before judging that update.
- **Real delivery never touches the local sink.** `drill real` posts to the pinned robot, so `notifications-sink.json` and the sink's accumulated history say nothing about it. Read `notificationJobRows` and the receipts instead.
- **One attempt per job.** The fault-drills overlay sets `PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS=1`, so a retryable error is not retried. A `FAILED` job with a 429/5xx or `45009` is a stop-and-report result, not something to rerun blindly: rerunning sends more messages to the group.
- A `FAILED` job with `lastError` about a 4xx will never retry; retryable errors do. `DELIVERED` is written only after HTTP success, and for WeCom also `errcode=0`; the original response body is not persisted, so receipts are indirect.
- If `drill.notifications` reports a missing `INCIDENT_RECOVERED`, check `notificationDecision.reason`. `recovered-before-delivery` intentionally produces no second message.
