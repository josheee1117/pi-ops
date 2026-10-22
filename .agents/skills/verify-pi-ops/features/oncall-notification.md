# On-call notification

The center decides whether and when to notify, builds a plain-language summary, and delivers it as a durable job. In the local stack the webhook target is `notification-sink`, which records what it received. ADR-0030 governs what should be sent.

## Sub-features

- Incident OPEN: a bound health target that is unavailable is notifiable without waiting for the model (ADR-0030 rule 1).
- Recovery: after the open message was delivered, the Incident sends one `INCIDENT_RECOVERED`. If recovery arrives before the first delivery, the first message becomes "曾发生、现已恢复" and no separate recovery is sent.
- Diagnosis update: `INVESTIGATION_COMPLETED` is sent only when the completed report adds a structured repair action or a new impact fact. Completing an investigation alone sends nothing (ADR-0030 rule 3).
- Decision record: `notificationDecision` on the Incident says which rule fired (`action`, `reason`, `facts`, `valueKeys`), so a missing message can be explained rather than guessed.
- Delivery bookkeeping: each job has `status` (`PENDING`/`RUNNING`/`DELIVERED`/`FAILED`), `attempts` and `lastError`; a 429/5xx is retryable, a 4xx is terminal.
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

## Gotchas

- **The sink stores metadata only.** `deploy/local/sink/server.mjs` keeps `receivedAt`, `idempotencyKey`, `notificationId`, `type` and discards the body. `DELIVERED` proves the sink accepted the call, not that a human saw a message. Never claim you inspected the delivered WeCom body here.
- **Never point this at a real group.** `compose.env` targets `notification-sink`; `drive.sh doctor` fails if that changes. The JDK17 overlay uses a real robot from a gitignored `.env.jdk17` and must not be run as part of this skill.
- **Smoke is older than ADR-0030.** `deploy/local/smoke.sh` still asserts `INCIDENT_OPEN`, `INVESTIGATION_COMPLETED` and `INCIDENT_RECOVERED` together. On the current policy that can fail for a legitimate reason. Treat such a failure as a finding about the smoke, and do not edit the policy or the drill to make it pass.
- A `FAILED` job with `lastError` about a 4xx will never retry; retryable errors do. `DELIVERED` is written only after HTTP success, and for WeCom also `errcode=0`; the original response body is not persisted, so receipts are indirect.
- If `drill.notifications` reports a missing `INCIDENT_RECOVERED`, check `notificationDecision.reason`. `recovered-before-delivery` intentionally produces no second message.
