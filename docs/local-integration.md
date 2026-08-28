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

No token inherits another role.

## Startup

```bash
pnpm start:local
# or
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env up --build
```

Default health targets contain only `pi-ops-drill`. DataAsset is opt-in:

```bash
docker compose -f deploy/local/docker-compose.yml \
  --env-file deploy/local/compose.env \
  --env-file deploy/local/compose.env.dataasset \
  up -d pi-ops-node-agent
```

SQLite:

- Pi-Ops: `deploy/local/data/pi-ops/pi-ops.sqlite`
- Pi Runtime: `deploy/local/data/pi-runtime/runtime.sqlite`

Node Agent Docker access: `/var/run/docker.sock`.

## HTTP probe ownership

Node Agent owns target observation.

- Target timeout/unhealthy after a successful Node Agent call → canonical `http.probe` Evidence, `status=succeeded`, `data.healthy=false`.
- Pi-Ops cannot reach Node Agent, or Node Agent does not answer before the outer timeout → retryable collection failure. Pi-Ops does not synthesize target health.

Probe timeout inside Node Agent is bounded below the Pi-Ops evidence request timeout.

## Health

```bash
curl http://127.0.0.1:18080/health
curl http://127.0.0.1:18081/health
curl http://127.0.0.1:18090/health
curl http://127.0.0.1:18088/health
```

## Incident drill

```bash
curl -X POST http://127.0.0.1:18088/fail
# wait for health.failure → Incident → Evidence → Investigation
curl -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents
curl -X POST http://127.0.0.1:18088/ok
# wait for RECOVERED
```

Smoke selects `service=pi-ops-drill`, `nodeId=local-dev`, `type=health.failure`.

When `PI_OPS_PI_RUNTIME_URL` is set, Pi Runtime is the only reasoning plane. Completed evidence is reconciled into an InvestigationSession on startup and after evidence completion. `ingest` cannot call `/v1/ops/*`.

## Smoke

Deterministic (FakeRuntimeModel inside Pi Runtime):

```bash
bash deploy/local/smoke.sh
```

Does not require DataAsset.

Real Pi provider (not CI). Requires gitignored `deploy/local/.env`. Missing credentials fail closed; no FakeRuntimeModel fallback.

```bash
pnpm smoke:pi
```

This is **not** part of `pnpm test`.

## Shutdown / cleanup

```bash
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env down
rm -rf deploy/local/data
```

## Known limitations

- Local dummy tokens only; the three roles must stay distinct.
- Deterministic RuntimeModel is the repeatable gate. Live Pi SDK is optional.
- Node Agent needs a working Docker socket on the developer machine.
- `host.disk` is not in the runtime allowlist.
- Log-line *values* are not secret-scanned; field-name redaction still applies.
