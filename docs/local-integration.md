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
Node Agent  →  Pi-Ops /v1/events
Pi-Ops      →  Node Agent /v1/evidence/query
Pi-Ops      →  Pi Runtime /v1/investigations
Pi Runtime  →  Pi-Ops /v1/investigation-results
Pi Runtime  →  Pi-Ops /v1/investigation-evidence
```

## Startup

```bash
pnpm start:local
# or
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env up --build
```

Config: `deploy/local/compose.env` (dummy local tokens, not production secrets).

SQLite:

- Pi-Ops: `deploy/local/data/pi-ops/pi-ops.sqlite`
- Pi Runtime: `deploy/local/data/pi-runtime/runtime.sqlite`

Node Agent Docker access: `/var/run/docker.sock`.

Allowed containers: `pi-ops-drill`, `data-asset-dev-jdk17`.

Optional DataAsset health target (Node Agent → host port):

```text
http://host.docker.internal:18089/actuator/health
```

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
curl -H 'Authorization: Bearer local-ingest-token' http://127.0.0.1:18080/v1/ops/incidents
curl -X POST http://127.0.0.1:18088/ok
# wait for RECOVERED
```

Evidence collection after OPEN is automatic. Investigation submits to Pi Runtime when `PI_OPS_PI_RUNTIME_URL` is set.

Manual submit:

```bash
curl -X POST http://127.0.0.1:18080/v1/ops/investigations \
  -H 'Authorization: Bearer local-ingest-token' \
  -H 'content-type: application/json' \
  -d '{"incidentId":"inc-..."}'
```

## Smoke

Deterministic (FakeRuntimeModel):

```bash
bash deploy/local/smoke.sh
```

Real Pi provider (not CI). Requires gitignored `deploy/local/.env`:

```text
PI_OPS_PI_PROVIDER=...
PI_OPS_PI_MODEL=...
PI_OPS_PI_API_KEY=...
```

```bash
pnpm smoke:pi
```

If provider/model/key are missing, this command fails closed and does not fall back to FakeRuntimeModel.

This is **not** part of `pnpm test`.

## Shutdown / cleanup

```bash
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/compose.env down
rm -rf deploy/local/data
```

## Known limitations

- Local dummy tokens only.
- Deterministic RuntimeModel is the repeatable gate. Live Pi SDK is optional.
- Node Agent needs a working Docker socket on the developer machine.
- `host.disk` is not in the runtime allowlist.
- Log-line *values* are not secret-scanned; field-name redaction still applies.
