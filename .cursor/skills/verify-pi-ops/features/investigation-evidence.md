# Investigation and evidence

An open incident triggers evidence collection from the node and an investigation run in pi-runtime. The operator can read the evidence in a model-safe view (secrets redacted) or raw.

## Sub-features

- `ie-session`: exactly one investigation session per incident reaches COMPLETED.
- `ie-safe`: the safe view contains `host.memory` and no secret values.
- `ie-raw`: the raw view keeps the original `host.memory` record.

## How to get to it (user POV)

- `GET /v1/ops/incidents/:id` → `sessions[]`.
- `GET /v1/ops/incidents/:id/evidence?view=safe|raw`.

## Driving it with control-pi-ops

Preconditions: an OPEN incident from [incident-lifecycle](./incident-lifecycle.md).

- **Wait for the investigation:** `$CTL wait-session <id>` → `session.status == "COMPLETED"`.
- **Stability:** wait 3s, `$CTL incident <id>` → `sessions` length 1.
- **Safe view:** `$CTL evidence <id> --view safe` → kinds include `host.memory`, `http.probe`, `docker.inspect`, `docker.logs`, and the string `super-secret` does not appear.
- **Raw view:** `$CTL evidence <id> --view raw` → `view == "raw"`, includes `host.memory`.

## Gotchas

- Only the fake reasoner is drivable. A FAILED session with the real Pi profile means missing `PI_MODEL_*` credentials, not a bug to "fix" by switching config.
