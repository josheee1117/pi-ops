# Incident lifecycle

Events that share a fingerprint inside the aggregation window (default 5 minutes) land on one Incident. Continuing failure increments `eventCount` instead of creating a new Incident; the recovery fact closes the same Incident. The operator API exposes the result.

## Sub-features

- Fingerprint and aggregation window decide whether an event opens an Incident or joins an existing one.
- State machine: an open event sets `OPEN`; a recovery event sets `RECOVERED`. The Incident keeps the same id across the transition.
- `eventCount` counts linked events, so it shows how many facts were folded into the record.
- Exactly one investigation session per Incident generation: `GET /v1/ops/incidents/:id` returning two sessions means duplicate submission.
- The notification decision (`policyVersion`, `action`, `reason`, `facts`, `valueKeys`) is part of the Incident record and explains why a message was or was not sent.

## How to get to it (user POV)

The operator lists Incidents and opens one:

```bash
curl -fsS -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents
curl -fsS -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents/<id>
```

What the operator reads: one row per failure window with `state`, `eventCount`, `firstSeen`, `lastSeen`; the detail adds evidence, sessions and notification jobs.

## Driving it with drive.sh

`drive.sh drill health` covers the open and the recovery half of this feature:

- `drill.incident` proves the failure event opened a new `health.failure` Incident.
- `drill.recovery` proves `POST /ok` moved the same Incident to `RECOVERED`; the id does not change.
- The final `drill` line repeats `incidentId` and `state`, and `incident-detail.json` in the evidence contains `eventCount`, both timestamps, and the session list.

Passing end state: the Incident created by this run is `RECOVERED`, its `eventCount` is at least 2 (failure plus recovery), and it has exactly one session.

## Gotchas

- The driver does not currently hold the failure open across several probe intervals, so it does not demonstrate `eventCount` growing under continued failure. If a change touches aggregation, keep the drill at `/fail` for a minute and check that the count rises without a second Incident.
- A `health.failure` incident whose state stays `OPEN` after `/ok` means the recovery event did not reach the center; look at the node agent log for the probe recovery and at `PI_OPS_HEALTH_FAILURE_DURATION`.
- ADR-0030 makes health-target identity part of the fingerprint, so a re-failure after recovery creates a new Incident on purpose. Two Incidents for two separated failures are correct; two Incidents for one failure window are not.
- Reusing the SQLite data (`launch --keep-data`) can leave old Incidents in the list. The drill filters by `firstSeen` after the run start, but evidence files will then contain older history too. Prefer a fresh launch.
