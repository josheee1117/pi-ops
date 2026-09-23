#!/usr/bin/env bash
set -euo pipefail

# INV-STALE-01 with real process boundaries: a SUBMITTED InvestigationSession
# must become FAILED once the stale timeout elapses, and the retry must stay
# bounded by maxAttempts.
#
# The Runtime is made unable to deliver its result, so the session genuinely
# sits in SUBMITTED instead of completing in milliseconds. That is what makes
# the stale window observable; the Runtime is then killed for real.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE=(docker compose
  -f "$ROOT/deploy/local/docker-compose.yml"
  -f "$ROOT/deploy/local/docker-compose.stale.yml"
  --env-file "$ROOT/deploy/local/compose.env")
OPERATOR=local-operator-token
PI_OPS=http://127.0.0.1:18080
DRILL=http://127.0.0.1:18088
RUNTIME_URL=http://127.0.0.1:18090
SQLITE="$ROOT/deploy/local/data/pi-ops/pi-ops.sqlite"
STALE_TIMEOUT_S=15
MAX_ATTEMPTS=2

wait_http() {
  local url=$1
  local n=0
  while (( n < 60 )); do
    if curl -fsS "$url" >/dev/null; then return 0; fi
    n=$((n + 1))
    sleep 2
  done
  echo "timeout waiting for $url" >&2
  return 1
}

incident_detail() {
  curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$1"
}

session_states() {
  incident_detail "$1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(s["status"] for s in (d.get("sessions") or [])))'
}

echo "== clean smoke sqlite =="
"${COMPOSE[@]}" down >/dev/null 2>&1 || true
rm -rf "$ROOT/deploy/local/data/pi-ops" "$ROOT/deploy/local/data/pi-runtime"
mkdir -p "$ROOT/deploy/local/data/pi-ops" "$ROOT/deploy/local/data/pi-runtime"

echo "== build + start with the stale overlay =="
"${COMPOSE[@]}" up -d --build
wait_http "$PI_OPS/health"
wait_http "$DRILL/health"
wait_http "$RUNTIME_URL/health"

echo "== stale configuration is active in the container =="
"${COMPOSE[@]}" exec -T pi-ops printenv \
  PI_OPS_INVESTIGATION_STALE_TIMEOUT_MS \
  PI_OPS_INVESTIGATION_RETRY_MAX_ATTEMPTS \
  PI_OPS_PI_RUNTIME_CALLBACK_URL

echo "== controlled failure =="
curl -fsS -X POST "$DRILL/fail" >/dev/null

incident_id=""
for _ in $(seq 1 40); do
  payload=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents")
  incident_id=$(PAYLOAD="$payload" python3 -c 'import json,os; rows=[i for i in json.loads(os.environ["PAYLOAD"]).get("incidents") or [] if i.get("type")=="health.failure" and i.get("service")=="pi-ops-drill"]; print(rows[-1]["id"] if rows else "")')
  if [[ -n "$incident_id" ]]; then break; fi
  sleep 2
done
[[ -n "$incident_id" ]] || { echo "no health.failure incident"; exit 1; }
echo "incident $incident_id"

echo "== wait for a real SUBMITTED session =="
observed=""
for _ in $(seq 1 120); do
  states=$(session_states "$incident_id")
  if [[ "$states" == *SUBMITTED* ]]; then observed=SUBMITTED; break; fi
  if [[ "$states" == *RUNNING* ]]; then observed=RUNNING; break; fi
  if [[ "$states" == *FAILED* ]]; then echo "session FAILED before it could be observed as pending: $states"; exit 1; fi
  sleep 0.5
done
[[ -n "$observed" ]] || { echo "session never reached SUBMITTED/RUNNING"; exit 1; }
echo "observed $observed"

echo "== kill the Runtime (real process death after the ACK) =="
"${COMPOSE[@]}" kill pi-runtime >/dev/null

echo "== wait for the stale timeout to fail the session =="
failed=0
for _ in $(seq 1 120); do
  states=$(session_states "$incident_id")
  if [[ "$states" == FAILED* ]]; then failed=1; break; fi
  sleep 1
done
[[ "$failed" -eq 1 ]] || { echo "first session never went FAILED: $states"; exit 1; }
echo "first session FAILED: $states"

echo "== wait for the bounded retry =="
retried=0
for _ in $(seq 1 90); do
  count=$(session_states "$incident_id" | wc -w | tr -d ' ')
  if [[ "$count" -ge "$MAX_ATTEMPTS" ]]; then retried=1; break; fi
  sleep 1
done
[[ "$retried" -eq 1 ]] || { echo "no retry attempt appeared"; exit 1; }

echo "== hold past the retry window and confirm the bound =="
sleep 20
final_states=$(session_states "$incident_id")
final_count=$(echo "$final_states" | wc -w | tr -d ' ')
echo "attempts=$final_count states=$final_states"
[[ "$final_count" -eq "$MAX_ATTEMPTS" ]] || { echo "expected exactly $MAX_ATTEMPTS attempts, got $final_count"; exit 1; }

echo "== persisted evidence =="
python3 - "$SQLITE" "$incident_id" "$STALE_TIMEOUT_S" "$MAX_ATTEMPTS" <<'PY'
import datetime, json, sqlite3, sys

db_path, incident, stale_s, max_attempts = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
db = sqlite3.connect(db_path)
db.row_factory = sqlite3.Row
rows = [dict(row) for row in db.execute(
    "SELECT s.id, s.status, s.submitted_at, s.completed_at, t.last_error "
    "FROM investigation_sessions s "
    "LEFT JOIN delegation_tasks t ON t.id = s.delegation_task_id "
    "WHERE s.incident_id = ? ORDER BY s.created_at, s.id",
    (incident,),
)]
print(json.dumps(rows, indent=2))

assert len(rows) == max_attempts, "expected exactly {} attempts, got {}".format(max_attempts, len(rows))

first = rows[0]
assert first["status"] == "FAILED", first
assert first["submitted_at"] and first["completed_at"], first

def parse(ts):
    return datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ")

age = (parse(first["completed_at"]) - parse(first["submitted_at"])).total_seconds()
print("first attempt lived {:.1f}s before FAILED (stale timeout {}s)".format(age, stale_s))
assert age >= stale_s, "FAILED before the stale timeout: {:.1f}s".format(age)
assert "timeout" in (first["last_error"] or ""), first["last_error"]
print("stale reason:", first["last_error"])
PY

echo "== stop the stack =="
"${COMPOSE[@]}" down >/dev/null

echo "RUNTIME CRASH SMOKE OK incident=$incident_id"
