# Notifications

pi-ops tells humans about incidents through a webhook (WeCom group bot or generic). Locally the webhook is `notification-sink`, which records every delivery.

## Sub-features

- `nt-types`: an incident produces INCIDENT_OPEN, INVESTIGATION_COMPLETED and INCIDENT_RECOVERED.
- `nt-delivery`: the sink actually received them.
- `nt-idempotency`: each delivery's `Idempotency-Key` equals its notification id.

## How to get to it (user POV)

- The webhook receiver (a chat group in production) gets a message.
- The operator sees `notifications[]` on `GET /v1/ops/incidents/:id`.

## Driving it with control-pi-ops

Preconditions: one incident taken through OPEN → RECOVERED.

- **Recorded types:** `$CTL incident <id>` → `notifications[].type` ⊇ the three types above.
- **Delivered:** `$CTL notifications` → `items` non-empty, entries for this incident.
- **Idempotent:** every item has `idempotencyKey == notificationId`.

## Gotchas

- The sink log lives in `deploy/local/data/notifications`. `up` wipes it, so counts are per run.
- Real WeCom delivery (`WECOM_WEBHOOK_URL`) is not verified here; it needs a real webhook URL from the user.
