# ADR-0027: Durable operational notification delivery

- **Status**: Accepted
- **Date**: 2026-08-27
- **Scope**: How Pi-Ops notifies operators of Incident opening, investigation completion, and recovery
- **Supersedes**: none
- **Related**: ADR-0001, ADR-0025, ADR-0026

## Context

Investigations now complete asynchronously through Pi Runtime. Operators still need a durable, idempotent signal when an Incident opens, when an InvestigationSession produces a report, and when the Incident recovers. Putting delivery inside Pi Runtime would mix reasoning with operations and could promote model text into facts.

## Decision

```text
Pi-Ops business transition
  → NotificationJob (deterministic id, SQLite)
  → NotificationWorker
  → Notifier.send(payload)
```

Pi-Ops owns notification delivery. Pi Runtime owns reasoning only.

Notification types:

- `INCIDENT_OPEN` — one logical job per Incident opening
- `INVESTIGATION_COMPLETED` — one logical job per InvestigationSession
- `INCIDENT_RECOVERED` — one logical job per actual recovery transition

Jobs are scheduled in the same SQLite transaction as the business transition whenever that transition is already transactional. Event replay, runtime callback redelivery, worker restart, and process restart must not create additional jobs.

Payload separates deterministic facts from AI analysis:

- Incident / Event / Evidence = facts
- hypothesis / recommendation / confidence = analysis
- historical knowledge stays advisory and is not copied into the payload
- chain-of-thought is never persisted

Delivery is durable, idempotent, and recoverable. Transitions are state-guarded in SQLite:

```text
PENDING → RUNNING
RUNNING → DELIVERED
RUNNING → PENDING   (retryable)
RUNNING → FAILED    (exhaustion or terminal 4xx)
startup: stale RUNNING → PENDING
```

`DELIVERED` and `FAILED` cannot be overwritten by a late worker. `markNotificationJobDelivered` and `markNotificationJobRetry` update `WHERE id = ? AND status = 'RUNNING'`.

Delivery is at-least-once after a crash in `RUNNING`. The logical identity is `NotificationPayload.notificationId` (the deterministic job id). `HttpWebhookNotifier` sends `Idempotency-Key: <notificationId>`. Duplicate physical sends keep the same key.

`NotificationJob.createdAt` is the scheduling clock — when Pi-Ops persisted the job — not the business event time. Event occurrence stays in `payload.incident.firstSeen` / `lastSeen`. Historical replay therefore delivers `INCIDENT_OPEN` before `INCIDENT_RECOVERED`.

`FakeNotifier` is the test seam. `HttpWebhookNotifier` is an optional configured adapter: one target URL, optional bearer token, bounded timeout and response, retry 429 / 5xx / timeout / connection errors, ordinary 4xx terminal. Vendor credentials are not hard-coded. Logs never include secrets, tokens, or the webhook URL.

Notifier failure never mutates Incident, Event, Evidence, InvestigationSession, ReasoningResult, or MemoryEntry.

Notification does not grant remediation capability. The worker cannot restart containers, edit config, or call Node Agent.

## Consequences

Benefits:

- operators see lifecycle events even if Pi Runtime is down
- delivery survives process crash without notification storms

Costs:

- at-least-once send after a crash in RUNNING
- a missing webhook URL leaves jobs PENDING until configured

## Supersession rule

Do not move notification delivery into Pi Runtime, and do not treat model output as an operational fact.
