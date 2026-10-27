# Fault drill

The disposable workload `pi-ops-drill` serves `/health`, `POST /fail` and `POST /ok`. It exists so a real, observable unhealthy workload can enter the pipeline without touching DataAsset. The node agent probes `http://pi-ops-drill:8088/health` every 2s and needs one failed sample (`PI_OPS_HEALTH_FAILURE_DURATION=1`) to emit an event.

## Sub-features

- `POST /fail` makes `/health` return 503; the node agent's health detector reports a failure transition.
- `POST /ok` restores 200; the detector reports recovery.
- The workload is the only health target in the default stack (`PI_OPS_HEALTH_TARGETS` in `deploy/local/compose.env`).

## How to get to it (user POV)

An operator does not call the drill directly in production; this is the local stand-in for a workload going unhealthy. In this stack the operator (or the drift test) calls `POST http://127.0.0.1:18088/fail` and then watches the Incident list.

## Driving it with drive.sh

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh drill health
```

Steps 1 and 2 of the JSON output:

- `drill.start` (`ok:true`) means the drill was reset healthy and the sink baseline was read.
- `drill.incident` with an `incidentId` means a new OPEN `health.failure` Incident for `service=pi-ops-drill`, `nodeId=local-dev`, first seen after the run started.

Manual check:

```bash
curl -fsS -X POST http://127.0.0.1:18088/fail
curl -fsS -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents
```

Passing end state: within a few seconds, `/health` on 18088 returns 503 and the incident list contains an OPEN `health.failure` for `pi-ops-drill`. `POST /ok` returns 200 health again.

## Gotchas

- The drill starts healthy in a fresh container, so a run that never calls `/fail` proves nothing.
- A run that leaves the drill at `/fail` poisons the next run: the next incident appears immediately, before its own `/fail`. Always reset with `POST /ok`, which both `drill` and `cleanup` do.
- This detector path is the node agent's health probe, not the DataAsset `RecordingStream`/JFR path. Passing here says nothing about the DataAsset starter.
- If `drill.incident` times out, check `logs/pi-ops-node-agent.log` for the probe and `logs/pi-ops.log` for ingest; a 401 there means the node token and `compose.env` disagree.
