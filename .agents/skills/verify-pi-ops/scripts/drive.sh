#!/usr/bin/env bash
# drive.sh - scripted driver for the pi-ops local stack (verification only).
#
# Every command prints one JSON object per line on stdout. Progress and
# warnings go to stderr. A failing command exits non-zero after printing
# {"step":"...","ok":false,"error":"...","next":"..."}.
#
#   ./drive.sh launch   [--no-build] [--keep-data] [--reuse] [--dry-run]
#   ./drive.sh doctor
#   ./drive.sh drill    health [--dry-run] [--timeout SECONDS]
#   ./drive.sh drill    real [--cases W2,B3] [--execute]
#   ./drive.sh evidence [--dry-run]
#   ./drive.sh cleanup  [--dry-run] [--keep-data]
#   ./drive.sh runs
#   ./drive.sh help
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/local/docker-compose.yml"
ENV_FILE="$ROOT/deploy/local/compose.env"
DATA_DIR="$ROOT/deploy/local/data"

# Endpoints and tokens mirror deploy/local/compose.env. Override only to drive
# a stack that was started with different ports or tokens.
PI_OPS=${PI_OPS:-http://127.0.0.1:18080}
NODE_URL=${NODE_URL:-http://127.0.0.1:18081}
RUNTIME_URL=${RUNTIME_URL:-http://127.0.0.1:18090}
DRILL=${DRILL:-http://127.0.0.1:18088}
SINK=${SINK:-http://127.0.0.1:18099}
OPERATOR=${OPERATOR:-local-operator-token}
NODE_TOKEN=${NODE_TOKEN:-local-node-token}
RUNTIME_TOKEN=${RUNTIME_TOKEN:-local-runtime-token}
EXPECT_NODE_ID=${EXPECT_NODE_ID:-local-dev}
EVIDENCE_ROOT=${PI_OPS_VERIFY_EVIDENCE_ROOT:-$HOME/.cache/verify-evidence/pi-ops}

RUN_DIR=${RUN_DIR:-}
RUN_ID=${RUN_ID:-}
INCIDENT_ID=${INCIDENT_ID:-}
SESSION_ID=${SESSION_ID:-}
DATA_ARCHIVED=${DATA_ARCHIVED:-0}
STARTED_AT=${STARTED_AT:-}

log() { printf '[drive] %s\n' "$*" >&2; }

# emit <step> [key=value ...]; a value that parses as JSON is emitted as JSON.
# When a run directory is active the same line is appended to drive-log.jsonl there,
# so the evidence keeps the driver's own account of the run.
emit() {
  local line
  line=$(python3 - "$@" <<'PY'
import json, sys
step = sys.argv[1]
out = {"step": step}
for item in sys.argv[2:]:
    key, _, value = item.partition("=")
    try:
        out[key] = json.loads(value)
    except Exception:
        out[key] = value
print(json.dumps(out, ensure_ascii=False))
PY
)
  printf '%s\n' "$line"
  if [[ -n "$RUN_DIR" && -d "$RUN_DIR" ]]; then
    printf '%s\n' "$line" >>"$RUN_DIR/drive-log.jsonl"
  fi
}

die() { # die <step> <error> <next>
  emit "$1" ok=false "error=$2" "next=$3"
  exit 1
}

# emit_raw <json-line>: for lines produced by a python block, still logging them.
emit_raw() {
  printf '%s\n' "$1"
  if [[ -n "$RUN_DIR" && -d "$RUN_DIR" ]]; then
    printf '%s\n' "$1" >>"$RUN_DIR/drive-log.jsonl"
  fi
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

usage() {
  cat <<'USAGE'
drive.sh - scripted driver for the pi-ops local stack (verification only).

Every command prints one JSON object per line on stdout. Progress and
warnings go to stderr. A failing command exits non-zero after printing
{"step":"...","ok":false,"error":"...","next":"..."}.

  ./drive.sh launch   [--no-build] [--keep-data] [--reuse] [--dry-run]
  ./drive.sh doctor
  ./drive.sh drill    health [--dry-run] [--timeout SECONDS]
  ./drive.sh drill    real [--cases W2,B3] [--execute]
  ./drive.sh evidence [--dry-run]
  ./drive.sh cleanup  [--dry-run] [--keep-data]
  ./drive.sh runs
  ./drive.sh help

  drill real runs deploy/local/fault-drills.py with the real model and the
  pinned WeCom test robot, after hashing the rendered webhook. Without
  --execute it prints the plan and sends nothing.
USAGE
}

# ---------------------------------------------------------------- run state

run_load() {
  local pointer="$EVIDENCE_ROOT/current"
  [[ -z "$RUN_DIR" && -f "$pointer" ]] && RUN_DIR=$(cat "$pointer")
  [[ -n "$RUN_DIR" && -f "$RUN_DIR/state.env" ]] || return 1
  # shellcheck disable=SC1090
  . "$RUN_DIR/state.env"
  return 0
}

run_init() {
  local stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  RUN_DIR="$EVIDENCE_ROOT/$stamp-$$"
  RUN_ID=$(basename "$RUN_DIR")
  mkdir -p "$RUN_DIR"
  # A dry run must not move the pointer away from the run that is really active.
  [[ "${DRY_RUN:-0}" == "1" ]] || printf '%s\n' "$RUN_DIR" >"$EVIDENCE_ROOT/current"
  STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    printf 'RUN_ID=%s\n' "$RUN_ID"
    printf 'RUN_DIR=%s\n' "$RUN_DIR"
    printf 'STARTED_AT=%s\n' "$STARTED_AT"
  } >"$RUN_DIR/state.env"
}

state_set() { # state_set <key> <value>
  local key=$1 value=$2 tmp="$RUN_DIR/state.env.tmp"
  { grep -v "^${key}=" "$RUN_DIR/state.env" 2>/dev/null || true; printf '%s=%s\n' "$key" "$value"; } >"$tmp"
  mv "$tmp" "$RUN_DIR/state.env"
  if [[ "$key" == "RUN_ID" ]]; then RUN_ID=$value; elif [[ "$key" == "INCIDENT_ID" ]]; then INCIDENT_ID=$value
  elif [[ "$key" == "SESSION_ID" ]]; then SESSION_ID=$value; elif [[ "$key" == "DATA_ARCHIVED" ]]; then DATA_ARCHIVED=$value
  elif [[ "$key" == "STARTED_AT" ]]; then STARTED_AT=$value; fi
}

# ---------------------------------------------------------------- http helpers

wait_http() { # wait_http <url> <seconds>
  local url=$1 seconds=${2:-90} i=0
  while (( i < seconds )); do
    curl -fsS --max-time 5 "$url" >/dev/null 2>&1 && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

ops_get() { curl -fsS --max-time 10 -H "Authorization: Bearer $OPERATOR" "$@"; }

# ---------------------------------------------------------------- git metadata

git_meta() { # git_meta <file>
  {
    printf 'branch=%s\n' "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    printf 'head=%s\n' "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
    printf 'headAt=%s\n' "$(git -C "$ROOT" log -1 --format=%cI 2>/dev/null)"
    printf 'dirtyFiles=%s\n' "$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  } >"$1"
}

# ---------------------------------------------------------------- data lifecycle

archive_data() {
  local name src
  for name in pi-ops pi-runtime; do
    src="$DATA_DIR/$name"
    if [[ -d "$src" ]] && [[ -n "$(ls -A "$src" 2>/dev/null)" ]]; then
      mkdir -p "$RUN_DIR/preexisting-data"
      mv "$src" "$RUN_DIR/preexisting-data/$name"
      log "moved existing $name data to $RUN_DIR/preexisting-data/$name"
    fi
    mkdir -p "$src"
  done
  state_set DATA_ARCHIVED 1
}

restore_data() {
  local name src
  [[ "$DATA_ARCHIVED" == "1" ]] || return 0
  for name in pi-ops pi-runtime; do
    src="$DATA_DIR/$name"
    if [[ -d "$RUN_DIR/preexisting-data/$name" ]]; then
      rm -rf "$src"
      mv "$RUN_DIR/preexisting-data/$name" "$src"
      log "restored pre-existing $name data"
    else
      # The data directory was empty or absent at launch, so nothing to restore.
      rm -rf "$src"
    fi
  done
  state_set DATA_ARCHIVED 0
}

copy_data_to_evidence() {
  local name src
  mkdir -p "$RUN_DIR/data"
  for name in pi-ops pi-runtime; do
    src="$DATA_DIR/$name"
    [[ -d "$src" ]] || continue
    rm -rf "${RUN_DIR:?}/data/$name"
    cp -R "$src" "$RUN_DIR/data/$name"
  done
}

# ---------------------------------------------------------------- launch

cmd_launch() {
  local build=1 keep=0 dry=0 reuse=0
  while (($# > 0)); do
    case "$1" in
      --no-build) build=0 ;;
      --keep-data) keep=1 ;;
      --dry-run) dry=1 ;;
      --reuse) reuse=1 ;;
      *) die launch "unknown option $1" "run: drive.sh help" ;;
    esac
    shift
  done

  if (( reuse )) && run_load; then
    log "reusing run $RUN_ID"
  else
    DRY_RUN=$dry run_init
    log "new run $RUN_ID at $RUN_DIR"
  fi
  git_meta "$RUN_DIR/git.txt"

  if (( dry )); then
    emit launch ok=true dry_run=true run=$RUN_DIR
    emit launch.plan action="compose down (if this project has containers)" run=$RUN_DIR
    emit launch.plan action="archive $DATA_DIR/{pi-ops,pi-runtime} into run dir, start empty" keep_data=$keep run=$RUN_DIR
    emit launch.plan action="docker compose up -d$( ((build)) && printf ' --build')" run=$RUN_DIR
    return 0
  fi
  state_set STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ -n "$(compose ps -q 2>/dev/null)" ]]; then
    log "stopping containers left from an earlier launch"
    compose down >/dev/null 2>&1 || true
  fi

  if (( keep == 0 )); then archive_data; else log "--keep-data: continuing with existing SQLite data"; fi

  local started=$SECONDS
  local build_flag=""
  (( build )) && build_flag="--build"
  log "compose up -d $build_flag (build can take a few minutes)"
  # shellcheck disable=SC2086
  if ! compose up -d $build_flag >"$RUN_DIR/compose-up.log" 2>&1; then
    tail -n 20 "$RUN_DIR/compose-up.log" >&2
    die launch "compose up failed" "read $RUN_DIR/compose-up.log, fix the build, then rerun launch"
  fi

  local svc name url
  for svc in "pi-ops:$PI_OPS/health" "pi-runtime:$RUNTIME_URL/ready" "pi-ops-node-agent:$NODE_URL/health" \
             "pi-ops-drill:$DRILL/health" "notification-sink:$SINK/health"; do
    name=${svc%%:*}; url=${svc#*:}
    if ! wait_http "$url" 180; then
      compose ps >&2 || true
      die launch "$name did not become ready" "check: compose logs $name ; then rerun launch"
    fi
    emit launch.service name="$name" ok=true url="$url"
  done

  local incidents model
  incidents=$(ops_get "$PI_OPS/v1/ops/incidents" 2>/dev/null) ||
    die launch "operator API rejected the operator token" "check PI_OPS_OPERATOR_TOKEN against deploy/local/compose.env"
  model=$(curl -fsS --max-time 5 "$RUNTIME_URL/health" 2>/dev/null || printf '{}')
  emit launch ok=true run="$RUN_DIR" seconds=$((SECONDS - started)) \
    modelMode="$(printf '%s' "$model" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("modelMode","unknown"))')" \
    incidents="$(printf '%s' "$incidents" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("incidents") or []))')"
}

# ---------------------------------------------------------------- doctor

cmd_doctor() {
  local failures=0

  check() { # check <name> <ok:true|false> <detail> [next]
    if [[ -n "${4:-}" ]]; then
      emit "doctor.$1" ok="$2" "$3" "next=$4"
    else
      emit "doctor.$1" ok="$2" "$3"
    fi
    [[ "$2" == "true" ]] || failures=$((failures + 1))
  }

  if ! docker info >/dev/null 2>&1; then
    check docker false detail=unreachable next="start Docker/OrbStack, then rerun doctor"
    emit doctor ok=false failures=$failures
    return 1
  fi
  check docker true detail=reachable

  local psjson
  psjson=$(compose ps --format json 2>/dev/null | python3 -c '
import json, sys
rows = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        rows.append(json.loads(line))
    except Exception:
        pass
print(json.dumps(rows))')
  local expected="pi-ops pi-runtime pi-ops-node-agent pi-ops-drill notification-sink"
  local svc state bad=""
  for svc in $expected; do
    state=$(printf '%s' "$psjson" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
svc = sys.argv[1]
hit = [r for r in rows if r.get("Service") == svc]
if not hit:
    print("absent")
else:
    r = hit[0]
    print("%s/%s" % (r.get("State", "?"), r.get("Health", "")))
' "$svc")
    case "$state" in
      running/*) emit doctor.service ok=true service="$svc" state="$state" ;;
      *) bad="$bad $svc($state)"; emit doctor.service ok=false service="$svc" state="$state" ;;
    esac
  done
  if [[ -n "$bad" ]]; then
    check containers false "unhealthy=$bad" "run: drive.sh launch  (rebuilds and restarts the whole stack)"
  else
    check containers true detail="all 5 services running"
  fi

  local -a health_targets=("pi-ops:$PI_OPS/health" "pi-runtime:$RUNTIME_URL/health" "node-agent:$NODE_URL/health")
  local item name url
  for item in "${health_targets[@]}"; do
    name=${item%%:*}; url=${item#*:}
    if wait_http "$url" 1; then
      emit "doctor.health.$name" ok=true url="$url"
    else
      emit "doctor.health.$name" ok=false url="$url" next="compose logs $name"
      failures=$((failures + 1))
    fi
  done

  local model_mode model_note
  model_mode=$(curl -fsS --max-time 5 "$RUNTIME_URL/health" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("modelMode","unknown"))' 2>/dev/null || printf 'unknown')
  case "$model_mode" in
    FAKE) model_note="deterministic fake model: proves the chain, not model quality" ;;
    REAL) model_note="real model provider" ;;
    *) model_note="runtime did not answer: cannot tell which model runs" ;;
  esac
  emit doctor.reasoner ok=true modelMode="$model_mode" note="$model_note"

  if ops_get "$PI_OPS/v1/ops/incidents" >/dev/null 2>&1; then
    check operatorAuth true detail="GET /v1/ops/incidents returned 200"
  else
    check operatorAuth false detail="operator token rejected or agent down" "check PI_OPS_OPERATOR_TOKEN in deploy/local/compose.env"
  fi

  if curl -fsS --max-time 10 -H "Authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' \
       -d '{"type":"host.memory","incidentId":"inc-doctor"}' "$NODE_URL/v1/evidence/query" 2>/dev/null \
     | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["kind"]=="host.memory" and "usedPercent" in d["data"]' 2>/dev/null; then
    check nodeEvidence true detail="host.memory evidence query answered"
  else
    check nodeEvidence false detail="node agent refused host.memory query" "compose logs pi-ops-node-agent"
  fi

  if curl -fsS --max-time 5 "$SINK/notifications" >/dev/null 2>&1; then
    check sink true detail="webhook sink reachable"
  else
    check sink false detail="sink unreachable" "compose logs notification-sink"
  fi

  if [[ -f "$ENV_FILE" ]] && grep -q '^PI_OPS_NOTIFICATION_WEBHOOK_URL=http://notification-sink:8099/notify$' "$ENV_FILE"; then
    check notificationTarget true detail="webhook points at the local sink, not a real group"
  else
    check notificationTarget false detail="compose.env no longer points at notification-sink" \
      "stop: a drill would deliver messages somewhere outside this machine"
  fi

  local image_created head_at
  image_created=$(docker image inspect pi-ops-local-pi-ops --format '{{.Created}}' 2>/dev/null || true)
  # Only commits that touch build inputs make an image stale; a docs commit does not.
  head_at=$(git -C "$ROOT" log -1 --format=%cI -- apps packages deploy/docker package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json 2>/dev/null)
  python3 - "$image_created" "$head_at" <<'PY' || failures=$((failures + 1))
import json, re, sys
from datetime import datetime
image, head = sys.argv[1], sys.argv[2]
def parse(value):
    value = (value or "").strip().replace("Z", "+00:00")
    value = re.sub(r"(\.\d{6})\d+", r"\1", value)
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None
img, hd = parse(image), parse(head)
if not image:
    print(json.dumps({"step": "doctor.build", "ok": False, "detail": "image pi-ops-local-pi-ops missing", "next": "run: drive.sh launch"}))
    sys.exit(1)
if img and hd and img < hd:
    print(json.dumps({"step": "doctor.build", "ok": False, "detail": "image older than the last commit that changed build inputs", "next": "run: drive.sh launch  (rebuilds the image)"}))
    sys.exit(1)
print(json.dumps({"step": "doctor.build", "ok": True, "imageCreated": image, "headCommitAt": head}))
PY

  local dirty
  dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  emit doctor.worktree ok=true dirtyFiles="$dirty" \
    note="$( (( dirty > 0 )) && printf 'uncommitted changes: the image may not match any commit' || printf 'clean' )"

  if (( failures > 0 )); then
    emit doctor ok=false failures=$failures
    return 1
  fi
  emit doctor ok=true failures=0
}

# ---------------------------------------------------------------- drill

cmd_drill() {
  local scenario=${1:-}
  shift || true
  if [[ "$scenario" == "real" ]]; then
    cmd_drill_real "$@"
    return $?
  fi
  local dry=0 timeout=240
  while (($# > 0)); do
    case "$1" in
      --dry-run) dry=1 ;;
      --timeout) timeout=$2; shift ;;
      *) die drill "unknown option $1" "run: drive.sh help" ;;
    esac
    shift
  done
  [[ "$scenario" == "health" ]] || die drill "unknown scenario '${scenario:-}'" \
    "supported scenarios: health, real  (real sends messages to the pinned WeCom test robot; it needs --execute)"

  run_load || die drill "no current run" "run: drive.sh launch"

  if (( dry )); then
    emit drill ok=true dry_run=true scenario=health run="$RUN_DIR"
    emit drill.plan step=1 action="POST $DRILL/ok and wait for 200 health"
    emit drill.plan step=2 action="POST $DRILL/fail"
    emit drill.plan step=3 action="poll $PI_OPS/v1/ops/incidents for an OPEN health.failure of pi-ops-drill"
    emit drill.plan step=4 action="poll incident detail until one investigation session is COMPLETED"
    emit drill.plan step=5 action="POST $DRILL/ok and wait for state RECOVERED"
    emit drill.plan step=6 action="check INCIDENT_OPEN and INCIDENT_RECOVERED jobs DELIVERED and present in the sink; INVESTIGATION_COMPLETED is conditional (ADR-0030)"
    emit drill.plan step=7 action="read the incident brief summary as the message content"
    return 0
  fi

  if ! wait_http "$PI_OPS/health" 1 || ! wait_http "$DRILL/health" 1 || ! wait_http "$RUNTIME_URL/ready" 1; then
    die drill "stack is not up" "run: drive.sh doctor ; then drive.sh launch"
  fi

  local started_iso started_at=$SECONDS
  started_iso=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local baseline
  baseline=$(curl -fsS --max-time 5 "$SINK/notifications" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("items") or []))')

  curl -fsS --max-time 5 -X POST "$DRILL/ok" >/dev/null || die drill "drill /ok failed" "check compose logs pi-ops-drill"
  wait_http "$DRILL/health" 30 || die drill "drill did not report healthy" "compose logs pi-ops-drill"
  emit drill.start ok=true scenario=health run="$RUN_DIR" sinkBaseline="$baseline"

  curl -fsS --max-time 5 -X POST "$DRILL/fail" >/dev/null || die drill "drill /fail failed" "check compose logs pi-ops-drill"

  local incident_id="" i=0
  while (( i < 90 )); do
    incident_id=$(ops_get "$PI_OPS/v1/ops/incidents" 2>/dev/null | STARTED="$started_iso" python3 -c '
import json, os, sys
from datetime import datetime
started = datetime.fromisoformat(os.environ["STARTED"].replace("Z", "+00:00"))
rows = [i for i in (json.load(sys.stdin).get("incidents") or [])
        if i.get("type") == "health.failure" and i.get("service") == "pi-ops-drill"
        and i.get("nodeId") == os.environ.get("EXPECT_NODE_ID", "local-dev")]
fresh = []
for row in rows:
    try:
        if datetime.fromisoformat(row["firstSeen"].replace("Z", "+00:00")) >= started:
            fresh.append(row)
    except Exception:
        fresh.append(row)
opens = [i for i in fresh if i.get("state") == "OPEN"]
pick = sorted(opens, key=lambda i: i["lastSeen"])[-1] if opens else (sorted(fresh, key=lambda i: i["lastSeen"])[-1] if fresh else None)
print(pick["id"] if pick else "")' 2>/dev/null)
    [[ -n "$incident_id" ]] && break
    i=$((i + 1))
    sleep 2
  done
  [[ -n "$incident_id" ]] || die drill "no new health.failure incident within 180s" \
    "check: drive.sh doctor ; compose logs pi-ops-node-agent ; compose logs pi-ops"
  state_set INCIDENT_ID "$incident_id"
  emit drill.incident ok=true incidentId="$incident_id"

  local status=""
  i=0
  while (( i < timeout )); do
    ops_get "$PI_OPS/v1/ops/incidents/$incident_id" >"$RUN_DIR/incident-detail.json" 2>/dev/null || true
    status=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
sessions = d.get("sessions") or []
done = [s for s in sessions if s.get("status") in ("COMPLETED", "FAILED")]
print(done[0]["status"] if done else "")' "$RUN_DIR/incident-detail.json" 2>/dev/null)
    [[ -n "$status" ]] && break
    i=$((i + 1))
    sleep 2
  done
  [[ -n "$status" ]] || {
    die drill "investigation session did not finish within ${timeout}s" \
      "read $RUN_DIR/incident-detail.json ; compose logs pi-runtime ; compose logs pi-ops"
  }

  local session_id
  session_id=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print((d.get("sessions") or [{}])[0].get("id", ""))' "$RUN_DIR/incident-detail.json")
  state_set SESSION_ID "$session_id"
  local investigation
  investigation=$(python3 - "$RUN_DIR/incident-detail.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
s = (d.get("sessions") or [{}])[0]
r = s.get("report") or {}
print(json.dumps({"step": "drill.investigation", "ok": s.get("status") == "COMPLETED",
  "sessionId": s.get("id"), "status": s.get("status"), "reportId": s.get("reportId"),
  "hypothesis": r.get("hypothesis"), "confidence": r.get("confidence"),
  "recommendation": r.get("recommendation"),
  "evidenceKinds": sorted({e.get("kind") for e in d.get("evidence") or []})}, ensure_ascii=False))
PY
)
  emit_raw "$investigation"
  [[ "$status" == "COMPLETED" ]] || die drill "investigation ended $status" \
    "read $RUN_DIR/incident-detail.json ; compose logs pi-runtime"

  curl -fsS --max-time 5 -X POST "$DRILL/ok" >/dev/null || die drill "drill /ok failed" "check compose logs pi-ops-drill"
  local state="" recovered_at=""
  i=0
  while (( i < 90 )); do
    ops_get "$PI_OPS/v1/ops/incidents/$incident_id" >"$RUN_DIR/incident-detail.json" 2>/dev/null || true
    state=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["incident"]["state"])' "$RUN_DIR/incident-detail.json" 2>/dev/null)
    if [[ "$state" == "RECOVERED" ]]; then recovered_at=$(date -u +%Y-%m-%dT%H:%M:%SZ); break; fi
    i=$((i + 1))
    sleep 2
  done
  [[ "$state" == "RECOVERED" ]] || die drill "incident did not recover (state=${state:-unknown})" \
    "read $RUN_DIR/incident-detail.json ; compose logs pi-ops-node-agent"
  emit drill.recovery ok=true state=RECOVERED at="$recovered_at"

  # ADR-0030 rule 3: completing an investigation is not itself a notification.
  # Only a structured repair action or a new impact fact earns one diagnosis update.
  local required="INCIDENT_OPEN INCIDENT_RECOVERED"
  i=0
  while (( i < 20 )); do
    ops_get "$PI_OPS/v1/ops/incidents/$incident_id" >"$RUN_DIR/incident-detail.json" 2>/dev/null || true
    if python3 - "$RUN_DIR/incident-detail.json" $required <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
required = set(sys.argv[2:])
jobs = {j.get("type"): j for j in d.get("notifications") or []}
ok = required <= set(jobs) and all(jobs[t].get("status") == "DELIVERED" for t in required)
sys.exit(0 if ok else 1)
PY
    then break; fi
    i=$((i + 1))
    sleep 2
  done

  local notif_out notif_rc
  notif_out=$(python3 - "$RUN_DIR/incident-detail.json" $required <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
required = sys.argv[2:]
jobs = {j.get("type"): j for j in d.get("notifications") or []}
entry = lambda t: {"type": t, "status": jobs[t].get("status"), "id": jobs[t].get("id")}
missing = [t for t in required if t not in jobs]
not_delivered = [t for t in required if t in jobs and jobs[t].get("status") != "DELIVERED"]
out = {"step": "drill.notifications", "ok": not missing and not not_delivered,
       "required": [entry(t) for t in required if t in jobs],
       "missing": missing, "notDelivered": not_delivered,
       "diagnosisUpdate": entry("INVESTIGATION_COMPLETED") if "INVESTIGATION_COMPLETED" in jobs else None,
       "diagnosisUpdateNote": ("present" if "INVESTIGATION_COMPLETED" in jobs else
         "ADR-0030: an investigation that adds no repair action and no new impact fact sends no update")}
print(json.dumps(out, ensure_ascii=False))
sys.exit(0 if out["ok"] else 1)
PY
)
  notif_rc=$?
  emit_raw "$notif_out"
  (( notif_rc == 0 )) || die drill "required notifications were not delivered" \
    "read $RUN_DIR/incident-detail.json ; compose logs pi-ops notification-sink"

  local brief notice_out
  brief=$(ops_get "$PI_OPS/v1/ops/incidents/$incident_id/brief") || die drill "brief endpoint failed" "compose logs pi-ops"
  notice_out=$(BRIEF="$brief" python3 - <<'PY'
import json, os
brief = json.loads(os.environ["BRIEF"])
summary = brief.get("summary") or {}
print(json.dumps({"step": "drill.notice", "ok": bool(summary.get("whatHappened")),
  "source": "incident brief summary: the same plain-language summary the webhook body is built from",
  "scene": summary.get("scene"), "whatHappened": summary.get("whatHappened"),
  "severity": (summary.get("severity") or {}).get("level"),
  "recovery": summary.get("recovery")}, ensure_ascii=False))
PY
)
  emit_raw "$notice_out"

  local sink sink_out
  sink=$(curl -fsS --max-time 5 "$SINK/notifications")
  sink_out=$(SINK_JSON="$sink" DETAIL="$RUN_DIR/incident-detail.json" python3 - <<'PY'
import json, os
import sys as _sys
detail = json.load(open(os.environ["DETAIL"]))
items = json.loads(os.environ["SINK_JSON"]).get("items") or []
wanted = {j.get("notificationId") for j in detail.get("notifications") or []}
matched = [i for i in items if i.get("notificationId") in wanted]
ok = len(matched) == len(wanted) and all(i.get("idempotencyKey") == i.get("notificationId") for i in matched)
print(json.dumps({"step": "drill.sink", "ok": ok, "expected": len(wanted), "matched": len(matched),
  "types": sorted({str(i.get("type")) for i in matched}),
  "idempotencyKeysMatch": all(i.get("idempotencyKey") == i.get("notificationId") for i in matched)}, ensure_ascii=False))
_sys.exit(0 if ok else 1)
PY
)
  local sink_rc=$?
  emit_raw "$sink_out"
  (( sink_rc == 0 )) || die drill "sink did not receive one item per notification job" \
    "read $RUN_DIR/notifications-sink.json ; compose logs notification-sink"

  local all_ok
  all_ok=$(python3 - "$RUN_DIR/incident-detail.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
sessions = d.get("sessions") or []
if len(sessions) != 1 or sessions[0].get("status") != "COMPLETED":
    print("false"); sys.exit()
print("true")
PY
)
  [[ "$all_ok" == "true" ]] || die drill "expected exactly one COMPLETED session" \
    "read $RUN_DIR/incident-detail.json; rerun with a fresh launch if the data dir was reused"

  emit drill ok=true scenario=health run="$RUN_DIR" incidentId="$incident_id" sessionId="$session_id" \
    state="$state" durationSeconds=$((SECONDS - started_at))
}

# ---------------------------------------------------------------- real drill

# This scenario sends messages to the WeCom test robot, so the case list is
# fixed here, not free-form: each enabled case has an owner-authorized fault
# action and an expected Incident type. Adding one is a reviewed change.
real_case_enabled() {
  case "$1" in W2 | B3) return 0 ;; *) return 1 ;; esac
}

real_fault() {
  case "$1" in
    W2) printf '%s' 'POST /heap on the drill: allocate and retain memory until the JVM throws OutOfMemoryError: Java heap space (Xmx128m, container 512m)' ;;
    B3) printf '%s' 'POST /exit-nonzero on the drill: the JVM exits with status 17 and restart=no, so the container stays down' ;;
  esac
}

real_expected_incident() {
  case "$1" in
    W2) printf 'jvm.oom' ;;
    B3) printf 'container.die' ;;
  esac
}

real_recovery() {
  case "$1" in
    W2) printf 'none: no recovery event maps jvm.oom back to healthy, so the Incident stays OPEN (health can return 200 again)' ;;
    B3) printf 'none: the drill does not restart, and container.die has no recovery event mapping; the Incident stays OPEN' ;;
  esac
}

real_notifications() {
  case "$1" in
    W2) printf '%s' 'INCIDENT_OPEN; INVESTIGATION_COMPLETED only when the report carries a repair action (ADR-0030)' ;;
    B3) printf '%s' 'none: container.die decides record / container-exit-without-oom, so policy starts no session and sends no message' ;;
  esac
}

real_stack() { # real_stack <compose args...>; only ever touches project pi-ops-jdk17-local
  FAULT_CONTAINER=unused FAULT_SERVICE=unused PI_OPS_JDK17_RUN_ID=unused FAULT_HEALTH_TARGETS='[]' \
    docker compose -p pi-ops-jdk17-local \
      -f "$ROOT/deploy/local/docker-compose.yml" \
      -f "$ROOT/deploy/local/docker-compose.jdk17.yml" \
      -f "$ROOT/deploy/local/docker-compose.fault-drills.yml" \
      --env-file "$ROOT/deploy/local/compose.env" --env-file "$ROOT/deploy/local/.env.jdk17" "$@"
}

# These four host ports are what the fault-drills overlay publishes.
real_check_ports() {
  local port holder
  if ! command -v lsof >/dev/null 2>&1; then
    log "lsof not found: skipping the port preflight"
    return 0
  fi
  for port in 18080 18081 18089 18090; do
    holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 " (pid " $2 ")" }')
    [[ -z "$holder" ]] && continue
    die drill.real "host port $port is already taken by $holder" \
      "the real drill publishes 18080/18081/18089/18090 on 127.0.0.1; stop whatever holds the port, then rerun"
  done
}

# Reads the copied artifacts of one group and prints one JSON line per case.
# Exit status is 0 only when every case has an Incident of the expected type,
# the investigation and notification outcomes match the Incident's own
# notificationDecision (a record-only decision expects neither), both target
# receipts match, and nothing errored. It does not judge whether the diagnosis
# is right: that is the reader's job, from the hypothesis and the evidence ids
# printed here.
real_summarize() { # real_summarize <copied dir> <case=incidentType ...>
  local dest=$1
  shift
  local lines rc
  lines=$(python3 - "$dest" "$@" <<'PY'
import glob, json, os, sys

dest, *expects = sys.argv[1:]
expected = dict(item.split('=', 1) for item in expects)
failures = 0

# Mirror investigation-reconciler.ts: only these actions start a session, and a
# missing health binding overrides the decision. An incident in RECOVERED/CLOSED
# never starts a session. No decision at all proves nothing.
def expects_session(decision, state=None):
    if not decision or decision.get('action') is None:
        return True
    if state in ('RECOVERED', 'CLOSED'):
        return False
    action = decision.get('action')
    return (action in ('analyze', 'alert')
            or 'health-binding' in (decision.get('missing') or []))

# Only record-like decisions expect zero notifications.
def expects_zero_notifications(decision):
    return (decision or {}).get('action') == 'record' and 'health-binding' not in ((decision or {}).get('missing') or [])

def load(path, default=None):
    try:
        with open(path) as handle:
            return json.load(handle)
    except Exception:
        return default

for case in expected:
    row = {"step": "real.case", "case": case, "ok": False, "expectedIncidentType": expected[case]}
    copies = sorted(glob.glob(os.path.join(dest, case + '-*')))
    if not copies:
        row["error"] = "no copied evidence directory for this case"
        print(json.dumps(row, ensure_ascii=False))
        failures += 1
        continue
    base = copies[-1]
    art = os.path.join(base, 'artifacts')
    result = load(os.path.join(art, 'result.json'), {}) or {}
    truth = load(os.path.join(base, 'ground-truth.json'), {}) or {}
    rendered = load(os.path.join(art, 'notification-target-rendered.json'), {}) or {}
    container = load(os.path.join(art, 'notification-target-container.json'), {}) or {}
    incidents = load(os.path.join(art, 'settled-incidents.json'), []) or []
    job_rows = load(os.path.join(base, 'notification-jobs.json'), []) or []
    sessions, jobs, kinds, decisions = [], [], set(), []
    for path in sorted(glob.glob(os.path.join(art, 'settled-inc-*-detail.json'))):
        body = load(path, {}) or {}
        if isinstance(body.get('body'), str):
            try:
                body = json.loads(body['body'])
            except Exception:
                continue
        decision = body.get('notificationDecision') or {}
        state = (body.get('incident') or {}).get('state')
        decisions.append({'action': decision.get('action'), 'reason': decision.get('reason'),
                          'expectedSession': expects_session(decision, state),
                          'expectsZeroNotifications': expects_zero_notifications(decision)})
        for session in body.get('sessions') or []:
            report = session.get('report') or {}
            diagnosis = report.get('diagnosis') or {}
            summary = diagnosis.get('summary')
            sessions.append({
                "id": session.get('id'),
                "status": session.get('status'),
                "confidence": report.get('confidence'),
                "hypothesis": (report.get('hypothesis') or '')[:500],
                "supportingEvidenceIds": len(report.get('supportingEvidenceIds') or []),
                "diagnosisPresent": bool(report.get('diagnosis')),
                "diagnosisSummary": json.dumps(summary, ensure_ascii=False)[:400] if summary is not None else None,
                "actions": [a.get('purpose') for a in (diagnosis.get('actions') or [])],
            })
        for job in body.get('notifications') or []:
            jobs.append({"type": job.get('type'), "status": job.get('status')})
        for item in body.get('evidence') or []:
            kinds.add(item.get('kind'))
    row.update({
        "copiedTo": base,
        "evidenceDirectory": result.get('evidenceDirectory') or truth.get('runId'),
        "faultActions": [{"path": a.get('path'), "status": a.get('status')} for a in truth.get('actions') or []],
        "incidentIds": [i.get('id') for i in incidents],
        "incidentTypes": [i.get('type') for i in incidents],
        "incidentStates": [i.get('state') for i in incidents],
        "sessions": sessions,
        "notificationDecisions": decisions,
        "evidenceKinds": sorted(k for k in kinds if k),
        "notifications": jobs,
        "notificationJobRows": [{"type": r.get('type'), "status": r.get('status'), "attempts": r.get('attempts'),
                                 "lastError": r.get('last_error'), "deliveredAt": r.get('delivered_at')}
                                for r in job_rows if 'type' in r],
        "notificationTarget": {
            "renderedMatch": rendered.get('match'),
            "containerMatch": container.get('match'),
            "kind": rendered.get('kind'),
            "targetSha256": rendered.get('targetSha256'),
            "senderStopped": container.get('senderStopped'),
        },
        "executionError": result.get('executionError'),
        "driverResult": {k: result.get(k) for k in
                         ('discovery', 'collection', 'diagnosis', 'notification', 'recovery', 'settleTimeout')},
    })
    delivered = bool(jobs) and all(job.get('status') == 'DELIVERED' for job in jobs)
    # A record-only case proves the chain by skipping both: no session and no message.
    no_session_expected = bool(decisions) and all(not item['expectedSession'] for item in decisions)
    zero_notifications_expected = bool(decisions) and all(item.get('expectsZeroNotifications') for item in decisions)
    row["checks"] = {
        "incidentType": expected[case] in row["incidentTypes"],
        "sessionCompleted": not sessions if no_session_expected else any(s.get('status') == 'COMPLETED' for s in sessions),
        "allNotificationsDelivered": not jobs if zero_notifications_expected else delivered,
        "notificationTargetPinned": rendered.get('match') is True and container.get('match') is True,
        "noExecutionError": not result.get('executionError'),
    }
    row["ok"] = all(row["checks"].values())
    row["judgement"] = (('notificationDecisions say record-only, so no session and no message is the expected outcome; '
                         if (no_session_expected and zero_notifications_expected) else
                         'DELIVERED means the WeCom API returned errcode=0 for the pinned test robot; '
                         'it does not mean a human saw the message; ')
                        + 'read hypothesis and supportingEvidenceIds against the injected fault.')
    if not row["ok"]:
        failures += 1
    print(json.dumps(row, ensure_ascii=False))

sys.exit(0 if failures == 0 else 1)
PY
)
  rc=$?
  [[ -n "$lines" ]] && printf '%s\n' "$lines" >"$dest/cases.jsonl"
  while IFS= read -r line; do
    [[ -n "$line" ]] && emit_raw "$line"
  done <<<"$lines"
  return "$rc"
}

# real_collect <group dir> <copy dir> <case=incidentType ...>: copies one group's
# case artifacts out of the repo, exports the notification job rows, and prints
# the per-case summary lines. Returns the summary status.
real_collect() {
  local group=$1 dest=$2
  shift 2
  local gf case_id case_dir case_copy
  for gf in results.json docker-version.txt git-head.txt jdk-version.txt; do
    [[ -f "$group/$gf" ]] && cp "$group/$gf" "$dest/" 2>/dev/null
  done
  while IFS=$'\t' read -r case_id case_dir; do
    [[ -n "$case_dir" && -d "$case_dir" ]] || continue
    case_copy="$dest/$case_id-$(basename "$case_dir")"
    rsync -a --exclude='*.jfr' --exclude='*.sqlite' --exclude='*-tables.json' --exclude='integration.diff' \
      "$case_dir/" "$case_copy/" || log "rsync failed for $case_id"
    # Delivery bookkeeping is not on the operator API: export just the job columns.
    python3 - "$case_dir/pi-ops/pi-ops.sqlite" "$case_copy/notification-jobs.json" <<'PY'
import json, os, sqlite3, sys

db, out = sys.argv[1], sys.argv[2]
rows = []
if os.path.exists(db):
    try:
        conn = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
        conn.row_factory = sqlite3.Row
        rows = [dict(row) for row in conn.execute(
            'SELECT id, type, status, attempts, last_error, created_at, delivered_at '
            'FROM notification_jobs ORDER BY created_at')]
        conn.close()
    except Exception as error:
        rows = [{'error': type(error).__name__}]
with open(out, 'w') as handle:
    json.dump(rows, handle, ensure_ascii=False, indent=2)
PY
  done < <(python3 - "$group/results.json" <<'PY'
import json, sys
try:
    rows = json.load(open(sys.argv[1]))
except Exception:
    rows = []
for row in rows:
    print('%s\t%s' % (row.get('case'), row.get('evidenceDirectory') or ''))
PY
)
  real_summarize "$dest" "$@"
}

cmd_drill_real() {
  local cases=W2,B3 execute=0
  while (($# > 0)); do
    case "$1" in
      --cases) cases=${2:-}; shift ;;
      --execute) execute=1 ;;
      --dry-run) execute=0 ;;
      *) die drill.real "unknown option $1" "run: drive.sh help" ;;
    esac
    shift
  done

  local case_list c
  case_list=${cases//,/ }
  [[ -n "$case_list" ]] || die drill.real "--cases needs at least one case" "example: --cases W2,B3"
  for c in $case_list; do
    real_case_enabled "$c" || die drill.real "case '$c' is not enabled for the real drill" \
      "enabled: W2 B3. Another case needs owner authorization, real_fault/real_expected_incident entries, and a note in features/diagnosis.md"
  done

  local fault_drills="$ROOT/deploy/local/fault-drills.py"
  [[ -f "$fault_drills" ]] || die drill.real "deploy/local/fault-drills.py is missing" \
    "this scenario only wraps that script; restore it from git"
  command -v docker >/dev/null 2>&1 || die drill.real "docker not found" "start Docker/OrbStack"
  docker info >/dev/null 2>&1 || die drill.real "Docker is not reachable" "start Docker/OrbStack, then rerun"
  command -v python3 >/dev/null 2>&1 || die drill.real "python3 not found" "fault-drills.py is stdlib Python 3"
  command -v rsync >/dev/null 2>&1 || die drill.real "rsync not found" \
    "the drill copies its artifacts out of the repo with rsync"

  local f missing=""
  for f in .env .env.jdk17 .env.jdk17-models.json; do
    [[ -f "$ROOT/deploy/local/$f" ]] || missing="$missing $f"
  done
  [[ -z "$missing" ]] || die drill.real "missing gitignored credential or model files:$missing" \
    "ask the repository owner; do not create or paste these values yourself"

  # One stack at a time: the real drill owns the same host ports as the local stack.
  for f in pi-ops-local pi-ops-jdk17-local; do
    if [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$f" 2>/dev/null)" ]]; then
      die drill.real "compose project $f is running" \
        "stop it first: the real drill publishes 18080/18081/18089/18090 and runs on fresh data dirs"
    fi
  done
  real_check_ports

  local model model_ok
  model=${PI_OPS_JDK17_MODEL:-gpt-5.6-sol}
  model_ok=$(python3 - "$ROOT/deploy/local/.env.jdk17-models.json" "$model" <<'PY'
import json, sys
path, want = sys.argv[1], sys.argv[2]
try:
    providers = json.load(open(path)).get('providers')
except Exception:
    print('false'); sys.exit()
ids = []
if isinstance(providers, dict):
    for provider in providers.values():
        for entry in (provider or {}).get('models') or []:
            ids.append(entry.get('id') if isinstance(entry, dict) else entry)
print('true' if want in ids else 'false')
PY
)
  [[ "$model_ok" == "true" ]] || die drill.real "model $model is not configured in deploy/local/.env.jdk17-models.json" \
    "set PI_OPS_JDK17_MODEL to a configured model id; a provider 402/429/503 is a stop-and-report, not a reason to switch models"

  RUN_DIR="$EVIDENCE_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-real"
  local dirty
  dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  local exec_bool=false
  (( execute )) && exec_bool=true

  emit drill.real ok=true execute="$exec_bool" run="$RUN_DIR" \
    driver="deploy/local/fault-drills.py" composeProject=pi-ops-jdk17-local \
    model="$model" modelConfigured=true dirtyFiles="$dirty" \
    images="built from the working tree, not from HEAD: $dirty dirty file(s) are included" \
    notificationTargetNote="fault-drills.py hashes the rendered webhook and compares it with TEST_NOTIFICATION_URL_SHA256; anything but match:true stops before any send, and drive.sh never reads the URL"
  for c in $case_list; do
    emit drill.real.plan case="$c" fault="$(real_fault "$c")" expectedIncidentType="$(real_expected_incident "$c")" \
      recovery="$(real_recovery "$c")" \
      notifications="$(real_notifications "$c")"
  done
  emit drill.real.plan phase=run action="python3 deploy/local/fault-drills.py --execute --cases $cases --build, one case at a time, fresh data dir per case under deploy/local/data/jdk17/"
  emit drill.real.plan phase=copy action="copy each case's artifacts (no JFR binaries, no SQLite dumps) into $RUN_DIR/real/"
  emit drill.real.plan phase=stop action="docker compose -p pi-ops-jdk17-local down --remove-orphans, whatever the outcome"

  if (( execute == 0 )); then
    emit drill.real ok=true execute=false run="$RUN_DIR" \
      next="rerun with --execute to run it; nothing was started, nothing will be sent, and no evidence directory was created"
    return 0
  fi

  mkdir -p "$RUN_DIR/real"
  git_meta "$RUN_DIR/git.txt"
  git -C "$ROOT" status --porcelain >"$RUN_DIR/real/git-dirty.txt" 2>/dev/null || true

  local started=$SECONDS rc=0
  log "real drill: $case_list with model $model; messages go to the pinned WeCom test robot"
  log "building the images first, then one case at a time: about 5 to 15 minutes"
  python3 "$fault_drills" --execute --cases "$cases" --build 2>&1 | tee "$RUN_DIR/fault-drills.log"
  rc=${PIPESTATUS[0]}
  log "fault-drills.py exit=$rc after $((SECONDS - started))s"

  local group
  group=$(grep -m1 '^Evidence group: ' "$RUN_DIR/fault-drills.log" 2>/dev/null | sed 's/^Evidence group: //')
  if [[ -z "$group" || ! -d "$group" ]]; then
    group=$(ls -1dt "$ROOT"/deploy/local/data/fault-drills/*/ 2>/dev/null | head -1)
    group=${group%/}
  fi
  [[ -n "$group" && -d "$group" ]] || die drill.real "fault-drills.py left no evidence group" \
    "read $RUN_DIR/fault-drills.log"
  printf '%s\n' "$group" >"$RUN_DIR/real/source-group.txt"

  local dest="$RUN_DIR/real"
  local -a expect_args=()
  for c in $case_list; do expect_args+=("$c=$(real_expected_incident "$c")"); done
  local summary_rc=0
  real_collect "$group" "$dest" "${expect_args[@]}" || summary_rc=$?

  log "stopping compose project pi-ops-jdk17-local"
  real_stack down --remove-orphans >"$RUN_DIR/real/compose-down.log" 2>&1 ||
    log "compose down reported an error; see real/compose-down.log"
  local left left_ok=false
  left=$(docker ps -aq --filter 'label=com.docker.compose.project=pi-ops-jdk17-local' 2>/dev/null | wc -l | tr -d ' ')
  [[ "$left" == "0" ]] && left_ok=true
  emit drill.real.stack ok="$left_ok" containersLeft="$left"

  if (( rc == 0 )) && (( summary_rc == 0 )); then
    emit drill.real ok=true exitCode="$rc" cases="$cases" run="$RUN_DIR" \
      durationSeconds=$((SECONDS - started)) \
      next="read real/cases.jsonl and real/*/artifacts; ask the owner to confirm the WeCom test group saw the messages, the delivered body is not stored"
    return 0
  fi
  emit drill.real ok=false exitCode="$rc" summaryExit="$summary_rc" cases="$cases" run="$RUN_DIR" \
    next="read $RUN_DIR/real/cases.jsonl, real/source-group.txt and fault-drills.log; a provider 402/429/503 or a refused target is a stop-and-report"
  return 1
}

# ---------------------------------------------------------------- evidence

cmd_evidence() {
  local dry=0
  [[ "${1:-}" == "--dry-run" ]] && dry=1
  run_load || die evidence "no current run" "run: drive.sh launch"
  if (( dry )); then
    emit evidence ok=true dry_run=true run="$RUN_DIR" \
      files="incident-detail.json incident-brief.md evidence-safe.json evidence-raw.json notifications-sink.json compose-ps.json logs/ data/ run-meta.json"
    return 0
  fi
  mkdir -p "$RUN_DIR/logs"

  if wait_http "$PI_OPS/health" 1; then
    cmd_doctor >"$RUN_DIR/doctor.json" 2>"$RUN_DIR/doctor.stderr" || log "doctor reported failures; saved to doctor.json"
    if [[ -n "${INCIDENT_ID:-}" ]]; then
      ops_get "$PI_OPS/v1/ops/incidents/$INCIDENT_ID" >"$RUN_DIR/incident-detail.json" 2>/dev/null || true
      ops_get "$PI_OPS/v1/ops/incidents/$INCIDENT_ID/brief?format=markdown" >"$RUN_DIR/incident-brief.md" 2>/dev/null || true
      ops_get "$PI_OPS/v1/ops/incidents/$INCIDENT_ID/evidence?view=safe" >"$RUN_DIR/evidence-safe.json" 2>/dev/null || true
      ops_get "$PI_OPS/v1/ops/incidents/$INCIDENT_ID/evidence?view=raw" >"$RUN_DIR/evidence-raw.json" 2>/dev/null || true
    else
      log "no incident recorded in this run; capturing stack state only"
    fi
    curl -fsS --max-time 5 "$SINK/notifications" >"$RUN_DIR/notifications-sink.json" 2>/dev/null || true
    curl -fsS --max-time 5 "$RUNTIME_URL/health" >"$RUN_DIR/runtime-health.json" 2>/dev/null || true
    compose ps --format json >"$RUN_DIR/compose-ps.json" 2>/dev/null || true
    local svc
    for svc in pi-ops pi-runtime pi-ops-node-agent pi-ops-drill notification-sink; do
      compose logs --no-color --timestamps "$svc" >"$RUN_DIR/logs/$svc.log" 2>/dev/null || true
    done
    copy_data_to_evidence
  else
    log "stack is down; capturing files and git metadata only"
  fi

  git_meta "$RUN_DIR/git.txt"
  python3 - "$RUN_DIR" "$INCIDENT_ID" "$STARTED_AT" <<'PY'
import json, os, sys
run, incident, started = sys.argv[1], sys.argv[2], sys.argv[3]
meta = {"runId": os.path.basename(run), "incidentId": incident or None, "startedAt": started or None,
        "modelMode": None, "git": {}}
try:
    meta["modelMode"] = json.load(open(os.path.join(run, "runtime-health.json"))).get("modelMode")
except Exception:
    pass
try:
    for line in open(os.path.join(run, "git.txt")):
        k, _, v = line.strip().partition("=")
        meta["git"][k] = v
except Exception:
    pass
json.dump(meta, open(os.path.join(run, "run-meta.json"), "w"), indent=2, ensure_ascii=False)
PY

  write_evidence_readme "$RUN_DIR"
  local files
  files=$(cd "$RUN_DIR" && find . -type f | sed 's|^\./||' | sort | tr '\n' ' ')
  emit evidence ok=true run="$RUN_DIR" incidentId="${INCIDENT_ID:-}" modelMode="$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])) or {}).get("modelMode"))' "$RUN_DIR/run-meta.json" 2>/dev/null || printf unknown)" files="$files"
}

write_evidence_readme() {
  local dir=$1
  cat >"$dir/README.md" <<EOF
# pi-ops verification evidence

Run: \`$(basename "$dir")\`

| File | What it proves |
| --- | --- |
| \`run-meta.json\` | run id, incident id, model mode (FAKE/REAL), git branch/HEAD/dirty count |
| \`doctor.json\` | one JSON line per doctor check at capture time |
| \`incident-detail.json\` | operator view: incident state, evidence list, sessions and reports, notification jobs |
| \`incident-brief.md\` | the on-call brief, same plain-language summary the WeCom message is built from |
| \`evidence-safe.json\` | evidence as the model saw it (redacted, length-limited) |
| \`evidence-raw.json\` | unredacted evidence for this incident |
| \`notifications-sink.json\` | what the local webhook sink received (id, type, idempotency key only) |
| \`compose-ps.json\` | container state at capture time |
| \`logs/<service>.log\` | timestamped compose logs for the five services |
| \`data/<app>\` | copy of the SQLite volume (may be mid-write; the API JSON is authoritative) |
| \`git.txt\` | branch, HEAD, HEAD time, number of modified files |
EOF
}

# ---------------------------------------------------------------- cleanup

cmd_cleanup() {
  local dry=0 keep=0
  while (($# > 0)); do
    case "$1" in
      --dry-run) dry=1 ;;
      --keep-data) keep=1 ;;
      *) die cleanup "unknown option $1" "run: drive.sh help" ;;
    esac
    shift
  done
  run_load || die cleanup "no current run" "nothing to clean up"

  if (( dry )); then
    emit cleanup ok=true dry_run=true run="$RUN_DIR" \
      steps="capture evidence, compose down, restore pre-existing data (archived=$DATA_ARCHIVED), keep $RUN_DIR"
    return 0
  fi

  cmd_evidence >/dev/null 2>&1 || log "evidence capture reported problems; files in $RUN_DIR"
  if [[ -n "$(compose ps -q 2>/dev/null)" ]]; then
    compose down >"$RUN_DIR/compose-down.log" 2>&1 || log "compose down reported an error; see compose-down.log"
  fi
  if (( keep )); then
    log "--keep-data: leaving this run's SQLite data in place"
  else
    restore_data
  fi

  local left
  left=$(compose ps -q 2>/dev/null | wc -l | tr -d ' ')
  python3 - "$RUN_DIR" "$left" <<'PY'
import json, sys, os
run, left = sys.argv[1], sys.argv[2]
json.dump({"containersLeft": int(left), "evidenceDir": run},
          open(os.path.join(run, "cleanup.json"), "w"), indent=2)
PY
  (( left == 0 )) || die cleanup "compose down left $left containers" "run: docker compose -f $COMPOSE_FILE down"
  emit cleanup ok=true run="$RUN_DIR" evidence="$RUN_DIR" \
    next="proof files stay in $RUN_DIR; nothing else was deleted"
}

# ---------------------------------------------------------------- entry point

cmd_runs() {
  local dir
  if [[ -f "$EVIDENCE_ROOT/current" ]]; then log "current: $(cat "$EVIDENCE_ROOT/current")"; fi
  for dir in "$EVIDENCE_ROOT"/*/; do
    [[ -d "$dir" ]] || continue
    printf '%s\n' "${dir%/}"
  done
}

# Sourced (for testing a helper) vs executed: only the executed file dispatches.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  command=${1:-help}
  shift || true
  case "$command" in
    launch) cmd_launch "$@" ;;
    doctor) cmd_doctor ;;
    drill) cmd_drill "$@" ;;
    evidence) cmd_evidence "$@" ;;
    cleanup) cmd_cleanup "$@" ;;
    runs) cmd_runs ;;
    help | --help | -h) usage ;;
    *) usage >&2; exit 2 ;;
  esac
fi
