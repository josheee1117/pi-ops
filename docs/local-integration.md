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

## Shutdown / cleanup

```bash
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env down
rm -rf deploy/local/data
```
