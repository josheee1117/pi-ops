#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/local/.env"
COMPOSE=(docker compose -f "$ROOT/deploy/local/docker-compose.yml" --env-file "$ROOT/deploy/local/compose.env")
INGEST=local-ingest-token
PI_OPS=http://127.0.0.1:18080
DRILL=http://127.0.0.1:18088
RUNTIME_HOST=http://127.0.0.1:18091

if [[ ! -f "$ENV_FILE" ]]; then
  echo "BLOCKED: real Pi provider configuration required" >&2
  echo "Create gitignored $ENV_FILE with PI_OPS_PI_PROVIDER, PI_OPS_PI_MODEL, and PI_OPS_PI_API_KEY if needed." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${PI_OPS_PI_PROVIDER:-}" || -z "${PI_OPS_PI_MODEL:-}" ]]; then
  echo "BLOCKED: PI_OPS_PI_PROVIDER and PI_OPS_PI_MODEL are required" >&2
  exit 1
fi

echo "REAL PI GATE provider=${PI_OPS_PI_PROVIDER} model=${PI_OPS_PI_MODEL} (key not printed)"

wait_http() {
  local url=$1
  local n=0
  while (( n < 40 )); do
    if curl -fsS "$url" >/dev/null; then return 0; fi
    n=$((n + 1))
    sleep 2
  done
  echo "timeout waiting for $url" >&2
  return 1
}

echo "== ensure local stack (except compose runtime) =="
curl -fsS -X POST "$DRILL/ok" >/dev/null 2>&1 || true
sleep 6
docker compose -f "$ROOT/deploy/local/docker-compose.yml" --env-file "$ROOT/deploy/local/compose.env" up -d pi-ops-drill notification-sink pi-ops-node-agent
docker compose -f "$ROOT/deploy/local/docker-compose.yml" -f "$ROOT/deploy/local/docker-compose.real-pi.yml" --env-file "$ROOT/deploy/local/compose.env" up -d --force-recreate pi-ops
docker compose -f "$ROOT/deploy/local/docker-compose.yml" --env-file "$ROOT/deploy/local/compose.env" stop pi-runtime >/dev/null 2>&1 || true
wait_http "$PI_OPS/health"
wait_http "$DRILL/health"

RUNTIME_LOG=/tmp/pi-ops-smoke-pi-runtime.log
RUNTIME_SQLITE=$(mktemp /tmp/pi-runtime-real.XXXXXX)
cleanup() {
  if [[ -n "${RUNTIME_PID:-}" ]]; then kill "$RUNTIME_PID" >/dev/null 2>&1 || true; fi
  "${COMPOSE[@]}" -f "$ROOT/deploy/local/docker-compose.yml" --env-file "$ROOT/deploy/local/compose.env" up -d pi-runtime >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== start HOST Pi Runtime in REAL mode =="
if command -v lsof >/dev/null; then
  lsof -nP -iTCP:18091 -sTCP:LISTEN | awk 'NR>1 { print $2 }' | sort -u | xargs kill 2>/dev/null || true
  sleep 1
fi
export PI_OPS_REQUIRE_REAL_MODEL=1
export PI_OPS_PI_RUNTIME_TOKEN=local-runtime-token
export PI_OPS_PI_RUNTIME_PORT=18091
export PI_OPS_PI_RUNTIME_SQLITE_PATH="$RUNTIME_SQLITE"
export PI_OPS_PI_RUNTIME_CALLBACK_URL=http://127.0.0.1:18080/v1/investigation-results
export PI_OPS_PI_RUNTIME_CALLBACK_TIMEOUT_MS=8000
export PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS=300000
pnpm --filter @pi-ops/protocol build >/dev/null
( cd "$ROOT" && pnpm --filter @pi-ops/pi-runtime exec tsx src/index.ts >"$RUNTIME_LOG" 2>&1 ) &
RUNTIME_PID=$!
wait_http "$RUNTIME_HOST/health"
health=$(curl -fsS "$RUNTIME_HOST/health")
echo "runtime health $health"
HEALTH="$health" python3 - <<'PY'
import json, os, sys
h = json.loads(os.environ["HEALTH"])
if h.get("modelMode") == "FAKE" or h.get("provider") == "fake":
    print("FAIL: FakeRuntimeModel was used", h, file=sys.stderr)
    sys.exit(1)
if h.get("modelMode") != "REAL":
    print("FAIL: runtime did not declare REAL model mode", h, file=sys.stderr)
    sys.exit(1)
print("runtime declared REAL provider=%s model=%s" % (h.get("provider"), h.get("model")))
PY

echo "== real incident drill =="
curl -fsS -X POST "$DRILL/ok" >/dev/null || true
sleep 2
curl -fsS -X POST "$DRILL/fail" >/dev/null

incident_id=""
for _ in $(seq 1 40); do
  payload=$(curl -fsS -H "Authorization: Bearer $INGEST" "$PI_OPS/v1/ops/incidents")
  incident_id=$(PAYLOAD="$payload" python3 - <<'PY'
import json, os
rows = [i for i in json.loads(os.environ["PAYLOAD"]).get("incidents") or [] if i["type"]=="health.failure" and i["state"]=="OPEN"]
print(rows[-1]["id"] if rows else "")
PY
)
  if [[ -n "$incident_id" ]]; then break; fi
  sleep 2
done
[[ -n "$incident_id" ]] || { echo "no OPEN health.failure incident"; exit 1; }
echo "incident $incident_id"

session_status=""
detail=""
for _ in $(seq 1 100); do
  detail=$(curl -fsS -H "Authorization: Bearer $INGEST" "$PI_OPS/v1/ops/incidents/$incident_id")
  session_status=$(DETAIL="$detail" python3 - <<'PY'
import json, os
s = json.loads(os.environ["DETAIL"]).get("sessions") or []
print(s[-1]["status"] if s else "")
PY
)
  if [[ "$session_status" == "COMPLETED" || "$session_status" == "FAILED" ]]; then break; fi
  sleep 3
done
echo "session $session_status"
if [[ "$session_status" != "COMPLETED" ]]; then
  echo "$detail"
  echo "---- runtime log (no secrets) ----"
  rg -v "sk-|api[_-]?key|Authorization" "$RUNTIME_LOG" | tail -80
  exit 1
fi

DETAIL="$detail" python3 - <<'PY'
import json, os, re
data = json.loads(os.environ["DETAIL"])
sessions = data.get("sessions") or []
assert sessions, "no sessions"
sess = sessions[-1]
report = sess.get("report") or {}
audits = sess.get("evidenceAudits") or []
hyp = report.get("hypothesis") or ""
rec = report.get("recommendation") or ""
print("hypothesis:", hyp)
print("confidence:", report.get("confidence"))
print("recommendation:", rec)
print("supportingEvidenceIds:", report.get("supportingEvidenceIds"))
print("contradictingEvidenceIds:", report.get("contradictingEvidenceIds"))
print("enrichment audits:", audits)
blob = json.dumps(data)
for secret in ("sk-cpa-", "super-secret", "DB_PASSWORD=", "Bearer "):
    assert secret not in blob, "secret leaked into ops payload"
vague = ["there may be resource pressure", "please inspect logs"]
low = hyp.lower()
assert hyp.strip(), "empty hypothesis"
assert not any(v in low for v in vague), hyp
assert report.get("supportingEvidenceIds"), "report cited no evidence"
print("REAL PI DIAGNOSTIC GATE: structural PASS")
PY

calls=$(rg -c "model_mode=REAL|networkCalls|invoke" "$RUNTIME_LOG" || true)
echo "runtime log lines of interest (redacted):"
rg -v "sk-|api[_-]?key" "$RUNTIME_LOG" | rg -i "model_mode|provider=|investigation|error|REAL|FAKE" | tail -20
echo "REAL PI SMOKE structural OK incident=$incident_id"
echo "Restore drill health"
curl -fsS -X POST "$DRILL/ok" >/dev/null || true
