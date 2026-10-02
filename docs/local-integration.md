# Local integration baseline (Phase 12A)

Local-only topology. Do not use this document for remote test-infra.

## Topology

```text
Developer machine
  pi-ops            :8080  (host 18080)  SQLite /data/pi-ops
  pi-runtime        :8090  (host 18090)  SQLite /data/pi-runtime
  pi-ops-node-agent :8081  (host 18081)  Docker socket
  pi-ops-drill      :8088  (host 18088)  disposable HTTP workload
  notification-sink :8099  (host 18099)  webhook capture
```

Network:

```text
Node Agent  →  Pi-Ops /v1/events          (ingest token)
Pi-Ops      →  Node Agent /v1/evidence/query
Pi-Ops      →  Pi Runtime /v1/investigations
Pi Runtime  →  Pi-Ops /v1/investigation-results   (runtime token)
Pi Runtime  →  Pi-Ops /v1/investigation-evidence  (runtime token)
operator    →  Pi-Ops /v1/ops/*                   (operator token)
```

Tokens in `deploy/local/compose.env` are distinct dummy values:

- `PI_OPS_INGEST_TOKEN=local-ingest-token`
- `PI_OPS_OPERATOR_TOKEN=local-operator-token`
- `PI_OPS_PI_RUNTIME_TOKEN=local-runtime-token`

External Runtime is all-or-none: `PI_OPS_PI_RUNTIME_URL`, `PI_OPS_PI_RUNTIME_TOKEN`, and `PI_OPS_PI_RUNTIME_CALLBACK_URL` are all set, or none are set.

## Startup

```bash
pnpm start:local
# or
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env up --build
```

Default health targets contain only `pi-ops-drill`. DataAsset is opt-in via Compose override:

```bash
docker compose \
  -f deploy/local/docker-compose.yml \
  -f deploy/local/docker-compose.dataasset.yml \
  --env-file deploy/local/compose.env \
  up -d pi-ops-node-agent
```

## Investigation generation

One `EvidenceJob.generation` maps to at most one successful Investigation. Generation increments only when deterministic Evidence is requeued. Dynamic Evidence (`inv-${sessionId}-...`) does not start another generation.

SUBMITTED/RUNNING sessions older than `PI_OPS_INVESTIGATION_STALE_TIMEOUT_MS` fail and may retry within `PI_OPS_INVESTIGATION_RETRY_MAX_ATTEMPTS`.

## HTTP probe ownership

Node Agent owns target observation.

- Target timeout/unhealthy after a successful Node Agent call → canonical `http.probe` Evidence, `status=succeeded`, `data.healthy=false`.
- Pi-Ops cannot reach Node Agent, or Node Agent does not answer before the outer timeout → retryable collection failure.

## Incident drill

```bash
curl -X POST http://127.0.0.1:18088/fail
curl -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents
curl -X POST http://127.0.0.1:18088/ok
```

Smoke selects `service=pi-ops-drill`, `nodeId=local-dev`, `type=health.failure`, after wiping `deploy/local/data/pi-ops` and `deploy/local/data/pi-runtime`.

## Smoke

```bash
bash deploy/local/smoke.sh
```

Does not require DataAsset. `pnpm smoke:pi` is optional and fails closed without credentials.

## JDK17 application + WeCom drill (opt-in)

```bash
bash deploy/local/smoke-jdk17.sh
```

This separate Compose project (`pi-ops-jdk17-local`) runs a dependency-free JDK17
workload instead of DataAsset. It uses a real `RecordingStream` `jdk.CPULoad`
sample during a bounded 30-second CPU burst, a bounded queue, and a separate HTTP
sender. It does not post fabricated CPU metrics or block the JFR callback on HTTP.
The drill sender intentionally sends once; it does not replace DataAsset's production
transport or prove its retries. `CPU_THRESHOLD` defaults to 0.01 for the local
multi-core Docker VM and can be tuned through the environment.

Prepare three **gitignored** files before running:

- `deploy/local/.env`: `PI_OPS_PI_PROVIDER`, `PI_OPS_PI_MODEL`, `PI_OPS_PI_API_KEY`
  (the same credentials used by `smoke:pi`).
- `deploy/local/.env.jdk17`: `PI_OPS_NOTIFICATION_WEBHOOK_KIND=wecom` and
  `PI_OPS_NOTIFICATION_WEBHOOK_URL=<robot URL>`; never commit the URL/key.
- `deploy/local/.env.jdk17-models.json`: the matching Pi custom-provider model
  configuration, with a Docker-reachable `baseUrl`. For the local CPA gateway use
  `http://host.docker.internal:8317/v1`, not `127.0.0.1`.

The overlay defaults to the locally verified `cpa/gpt-5.6-sol`; override
`PI_OPS_JDK17_MODEL` only with a model registered in that model configuration.
Runtime is explicitly REAL-required: missing credentials, model failure, invalid
reports, or failed WeCom delivery fail the check, with no Fake fallback.

Acceptance: JFR + Docker + Host Evidence and a report citing the JFR Evidence;
then repeated health failure → one Incident / one investigation → recovery,
with OPEN / COMPLETED / RECOVERED notification jobs DELIVERED. The two scenarios
normally send five messages labelled by service `dataasset-jdk17-local-本地演练`.
DELIVERED means WeCom returned `errcode=0`; a human still confirms group visibility.

Each run uses fresh SQLite directories under `deploy/local/data/jdk17/<run-id>/`,
without deleting existing local data. Observation stops before container replacement;
this opt-in overlay uses a one-second Docker replay lookback to avoid replaying old
deployment failures into the group. The normal deployment lookback is unchanged.
On exit the script stops the observer and restores drill health, keeping the reports
available without continuing to forward unrelated Docker events to the group.
Ports overlap the default local stack; do not run both projects simultaneously.
This is **local chain validation**, not M5 remote acceptance or M7 real DataAsset acceptance.

### Verified local run — 2026-10-02

- Run directory: `deploy/local/data/jdk17/20261002-093410/` (ignored, evidence retained).
- Runtime: REAL `cpa/gpt-5.6-sol`; JDK: Temurin 17.0.20.1.
- White-box Incident: `inc-bdf58a9d-062c-4a9d-a86f-e6045e50f1ae`;
  report cites `jfr-3c359126-5829-4c03-94ea-cb1632d0bd2d`, with Docker/Host
  Evidence and a successful dynamic `docker.stats` collection.
- Health Incident: `inc-3cddd247-f9f5-452b-88c7-5ab5e63c8e62`;
  one COMPLETED session, RECOVERED, exactly three DELIVERED notification jobs.
- Both scenarios passed `smoke-jdk17.sh`; five intended notification jobs DELIVERED.
  Group visibility still requires human confirmation.
- Earlier DeepSeek and GLM attempts encountered upstream quota errors. The SDK
  adapter currently misreports an upstream error with empty text as invalid JSON;
  this run changed only local model configuration, not production error handling.
- Container replacement initially replayed old Docker failures into the group;
  the local stop-observation-first / one-second-lookback setup avoids that replay.
- Dynamic `docker.inspect` (CPU) and `docker.stats` (health) requests were rejected
  by trusted target resolution for this simulated service name; this run does not
  claim that every enrichment capability succeeded.

## Shutdown / cleanup

```bash
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env down
rm -rf deploy/local/data
```
