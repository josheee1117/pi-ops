#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/local/docker-compose.yml" --env-file "$ROOT/deploy/local/compose.env")
INGEST=local-ingest-token
OPERATOR=local-operator-token
RUNTIME=local-runtime-token
NODE=local-node-token
PI_OPS=http://127.0.0.1:18080
NODE_URL=http://127.0.0.1:18081
RUNTIME_URL=http://127.0.0.1:18090
DRILL=http://127.0.0.1:18088
SINK=http://127.0.0.1:18099

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

echo "== clean smoke sqlite =="
"${COMPOSE[@]}" down >/dev/null 2>&1 || true
rm -rf "$ROOT/deploy/local/data/pi-ops" "$ROOT/deploy/local/data/pi-runtime"
mkdir -p "$ROOT/deploy/local/data/pi-ops" "$ROOT/deploy/local/data/pi-runtime"

echo "== build + start =="
"${COMPOSE[@]}" up -d --build

echo "== health =="
wait_http "$PI_OPS/health"
wait_http "$NODE_URL/health"
wait_http "$RUNTIME_URL/health"
wait_http "$DRILL/health"
wait_http "$SINK/health"

echo "== network directions =="
curl -fsS "$NODE_URL/health" >/dev/null
curl -fsS -H "Authorization: Bearer $NODE" \
  -H 'content-type: application/json' \
  -d '{"type":"host.memory","incidentId":"inc-smoke"}' \
  "$NODE_URL/v1/evidence/query" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["kind"]=="host.memory" and "usedPercent" in d["data"]'
curl -fsS -H "Authorization: Bearer $RUNTIME" "$RUNTIME_URL/ready" >/dev/null
echo "four process health/evidence directions ok"

echo "== controlled failure =="
curl -fsS -X POST "$DRILL/fail" >/dev/null

incident_id=""
for _ in $(seq 1 40); do
  payload=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents")
  incident_id=$(PAYLOAD="$payload" python3 -c 'import json,os; rows=[i for i in json.loads(os.environ["PAYLOAD"]).get("incidents") or [] if i.get("type")=="health.failure" and i.get("service")=="pi-ops-drill" and i.get("nodeId")=="local-dev"]; open=[i for i in rows if i["state"]=="OPEN"]; pick=(open or sorted(rows, key=lambda i: i.get("lastSeen") or ""))[-1] if (open or rows) else None; print(pick["id"] if pick else "")')
  if [[ -n "$incident_id" ]]; then break; fi
  sleep 2
done
[[ -n "$incident_id" ]] || { echo "no health.failure incident"; exit 1; }
echo "incident $incident_id"

echo "== wait investigation =="
session_status=""
detail=""
for _ in $(seq 1 40); do
  detail=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id")
  session_status=$(DETAIL="$detail" python3 -c 'import json,os; sessions=json.loads(os.environ["DETAIL"]).get("sessions") or []; print(sessions[0]["status"] if sessions else "")')
  if [[ "$session_status" == "COMPLETED" || "$session_status" == "FAILED" ]]; then break; fi
  sleep 3
done
echo "session $session_status"
[[ "$session_status" == "COMPLETED" ]] || { echo "$detail"; exit 1; }

echo "== reconciliation stability =="
sleep 3
detail=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id")
DETAIL="$detail" python3 - <<'PY'
import json, os
data = json.loads(os.environ["DETAIL"])
sessions = data.get("sessions") or []
completed = [s for s in sessions if s.get("status") == "COMPLETED"]
assert len(sessions) == 1, sessions
assert len(completed) == 1, sessions
notes = [n for n in data.get("notifications") or [] if n.get("type") == "INVESTIGATION_COMPLETED"]
assert len(notes) == 1, notes
print("exactly one completed investigation session")
PY

echo "== evidence + model-safe =="
safe=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id/evidence?view=safe")
raw=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id/evidence?view=raw")
SAFE="$safe" python3 -c 'import json,os; data=json.loads(os.environ["SAFE"]); kinds={item["kind"] for item in data["evidence"]}; assert "host.memory" in kinds, kinds; blob=json.dumps(data); assert "super-secret" not in blob; print("safe kinds", sorted(kinds))'
RAW="$raw" python3 -c 'import json,os; data=json.loads(os.environ["RAW"]); assert data["view"]=="raw"; assert any(item["kind"]=="host.memory" for item in data["evidence"]); print("raw host.memory preserved")'

echo "== restore + recovery =="
curl -fsS -X POST "$DRILL/ok" >/dev/null
state=""
for _ in $(seq 1 40); do
  detail=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id")
  state=$(DETAIL="$detail" python3 -c 'import json,os; print(json.loads(os.environ["DETAIL"])["incident"]["state"])')
  if [[ "$state" == "RECOVERED" ]]; then break; fi
  sleep 2
done
[[ "$state" == "RECOVERED" ]] || { echo "not recovered: $state"; exit 1; }

echo "== notifications =="
detail=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id")
DETAIL="$detail" python3 -c 'import json,os; types={item["type"] for item in json.loads(os.environ["DETAIL"])["notifications"]}; needed={"INCIDENT_OPEN","INVESTIGATION_COMPLETED","INCIDENT_RECOVERED"}; assert needed <= types, types; print("notification types", sorted(types))'
sink=$(curl -fsS "$SINK/notifications")
SINK_JSON="$sink" python3 -c 'import json,os; items=json.loads(os.environ["SINK_JSON"])["items"]; assert items, "no webhook deliveries";
[item for item in items if item["idempotencyKey"]==item["notificationId"]];
assert all(item["idempotencyKey"]==item["notificationId"] for item in items); print("idempotency keys matched", len(items))'

echo "== persistence restart =="
"${COMPOSE[@]}" restart pi-ops
wait_http "$PI_OPS/health"
again=$(curl -fsS -H "Authorization: Bearer $OPERATOR" "$PI_OPS/v1/ops/incidents/$incident_id")
AGAIN="$again" python3 -c 'import json,os; data=json.loads(os.environ["AGAIN"]); assert data["incident"]["state"]=="RECOVERED"; assert data["sessions"]; assert data["notifications"]; print("pi-ops restart preserved incident", data["incident"]["id"])'
"${COMPOSE[@]}" restart pi-runtime
wait_http "$RUNTIME_URL/health"
"${COMPOSE[@]}" restart pi-ops-node-agent
wait_http "$NODE_URL/health"
curl -fsS -H "Authorization: Bearer $NODE" -H 'content-type: application/json' \
  -d '{"type":"host.load","incidentId":"inc-smoke"}' "$NODE_URL/v1/evidence/query" >/dev/null

echo "== runtime data-dependent finding + bound =="
python3 - <<'PY'
import json, time, urllib.request

def submit(tag, percent=None, blob=None):
    evidence = [{"id":"evd-load","kind":"host.load","incidentId":f"inc-local-{tag}","nodeId":"local-dev","source":"host","collectedAt":"2026-08-20T12:00:00.000Z","data":{"load1":0.1}}]
    if percent is not None:
        evidence.append({"id":"evd-mem","kind":"host.memory","incidentId":f"inc-local-{tag}","nodeId":"local-dev","source":"host","collectedAt":"2026-08-20T12:00:00.000Z","data":{"usedPercent":percent}})
    if blob is not None:
        evidence = [{"id":"evd-huge","kind":"host.load","incidentId":f"inc-local-{tag}","nodeId":"local-dev","source":"host","collectedAt":"2026-08-20T12:00:00.000Z","data":{"blob":blob}}]
    body={
      "schemaVersion":1,
      "runtimeRequestId":f"rreq-local-{tag}",
      "sessionId":f"isess-local-{tag}",
      "incidentId":f"inc-local-{tag}",
      "callbackUrl":"http://pi-ops:8080/v1/investigation-results",
      "context":{"schemaVersion":1,"incident":{"id":f"inc-local-{tag}","type":"health.failure","service":"pi-ops-drill"},"evidence":evidence}
    }
    req=urllib.request.Request("http://127.0.0.1:18090/v1/investigations", data=json.dumps(body).encode(), headers={"Authorization":"Bearer local-runtime-token","content-type":"application/json"})
    urllib.request.urlopen(req).read()

def task(tag):
    req=urllib.request.Request(f"http://127.0.0.1:18090/v1/tasks/rreq-local-{tag}", headers={"Authorization":"Bearer local-runtime-token"})
    return json.loads(urllib.request.urlopen(req).read().decode())

submit("92", percent=92)
submit("20", percent=20)
submit("huge", blob="x"*20000)
hyp92=hyp20=err=None
for _ in range(30):
    t92=task("92")
    t20=task("20")
    huge=task("huge")
    hyp92=t92.get("hypothesis")
    hyp20=t20.get("hypothesis")
    err=huge.get("error")
    if hyp92 and hyp20 and err:
        break
    time.sleep(1)
assert hyp92=="memory pressure observed", hyp92
assert hyp20=="memory pressure not observed", hyp20
assert huge.get("executionStatus")=="failed", huge
assert "context_too_large" in (err or ""), err
print("runtime data bound ok", hyp92, hyp20, err)
PY

echo "LOCAL SMOKE OK incident=$incident_id"
