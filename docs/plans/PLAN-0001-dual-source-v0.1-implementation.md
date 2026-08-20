# PLAN-0001: Dual-source Pi-Ops v0.1 implementation

- **Status**: Ready for Implementation
- **Date**: 2026-08-20
- **Executor**: AI Coding Agent
- **Architecture**: ADR-0001
- **Runtime target**: `test-svc-02` central agent + node agents on `test-svc-02` and `test-ai-01`

## 0. Mandatory rules for the coding agent

Before changing code, read:

```text
README.md
docs/adr/ADR-0001-dual-source-node-agent-architecture.md
docs/plans/PLAN-0001-dual-source-v0.1-implementation.md
```

Also inspect the real repository state before creating files. Do not blindly follow example paths when the implementation has already evolved.

Rules:

1. Execute exactly one milestone at a time unless explicitly instructed otherwise.
2. Do not implement Pi SDK/model prompts before deterministic event, incident and evidence flows work.
3. Do not rewrite DataAsset RecordingStream; its implementation lives in the DataAsset repository. Only define/adapt its transport contract when that milestone is reached.
4. No arbitrary shell endpoint/tool.
5. v0.1 is read-only: no restart, kill, redeploy, file write, DB write or configuration mutation.
6. Do not add Kafka, RocketMQ, Redis, Prometheus, Grafana or another infrastructure dependency as a prerequisite.
7. Secret values must come from environment/runtime configuration and never be committed.
8. Evidence facts and model hypotheses must be persisted as different data types.
9. Every collection API must have bounded input: allowlisted target, timeout, max log lines/bytes, and safe defaults.
10. Each milestone ends with tests, typecheck, README/config update when needed, one clear Git commit, and a short completion report.

## 1. v0.1 end state

Both paths must work:

```text
A. DataAsset white-box event
RecordingStream/JFR -> POST /v1/events -> Incident -> Evidence -> Pi

B. Third-party black-box event
Docker/Host/Health -> node-agent -> POST /v1/events -> Incident -> Evidence -> Pi
```

Completing only path A does not complete v0.1.

## 2. Workspace responsibilities

```text
apps/agent
  central HTTP ingress, persistence, incidents, evidence orchestration,
  PiReasoner, notification, audit

apps/node-agent
  Docker/host/health observers and typed read-only evidence API

packages/protocol
  one canonical OpsEvent/Evidence/API contract

test/integration
  cross-process and end-to-end scenarios
```

Do not duplicate protocol interfaces independently in both apps.

---

# Milestone 1 — Shared protocol

## Goal

Create the canonical typed contract in `packages/protocol`.

Minimum models:

```ts
interface OpsEvent {
  schemaVersion: 1;
  id: string;
  time: string;
  source: 'jfr' | 'application' | 'docker' | 'host' | 'health' | 'middleware' | 'deployment';
  nodeId: string;
  service: string;
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  fingerprint?: string;
  traceId?: string;
  message: string;
  attributes: Record<string, unknown>;
}

interface EventBatch {
  producer: {
    id: string;
    type: 'application' | 'node-agent';
    version: string;
  };
  events: OpsEvent[];
}

interface Evidence {
  id: string;
  incidentId: string;
  nodeId: string;
  source: string;
  kind: string;
  collectedAt: string;
  data: unknown;
}
```

Add runtime schema validation (Zod or equivalent) for external API payloads. Keep schema versioning explicit.

## Acceptance

- valid and invalid event tests
- batch-size limit exists
- unknown extra attributes can be carried in `attributes`
- both app workspaces import protocol from the package instead of copy/paste types

Stop after this milestone and report.

---

# Milestone 2 — Central agent event ingress + SQLite event store

## Goal

Make `apps/agent` accept and durably store events without any LLM.

API:

```text
POST /v1/events
Authorization: Bearer <ingest token>
```

Response semantics:

```json
{
  "accepted": 3,
  "rejected": 0
}
```

`accepted` means validated and persisted, not analyzed.

Also expose:

```text
GET /health
```

Persist at least:

- event id
- receive time
- producer
- source/node/service/type/severity
- fingerprint/trace id
- message
- attributes JSON

Requirements:

- duplicate event id is idempotent
- payload size and batch size bounded
- invalid event does not crash process
- token not printed in logs

## Acceptance

Use curl/test client to submit one valid event, restart agent, and verify event remains in SQLite.

Stop and report.

---

# Milestone 3 — Incident engine + deterministic dedupe/aggregation

## Goal

Transform repeated events into stable incidents before introducing AI.

Incident states:

```text
OPEN
INVESTIGATING
NOTIFIED
RECOVERED
CLOSED
```

Minimum persisted fields:

- id
- service/node
- type
- state
- fingerprint
- firstSeen/lastSeen
- eventCount
- severity

Fingerprint rule must be deterministic. Event-provided fingerprint may be used; otherwise derive from selected stable dimensions. Do not include timestamps or random data.

Implement recovery-event handling so a health or service incident can become RECOVERED.

## Acceptance

100 identical ERROR events within a window produce one Incident with `eventCount=100`, not 100 incidents.

Stop and report.

---

# Milestone 4 — Node Agent typed evidence API

## Goal

Create a read-only `apps/node-agent` HTTP service with identity/health and typed evidence queries.

Minimum endpoint:

```text
POST /v1/evidence/query
Authorization: Bearer <node token>
```

Initial query types:

```text
docker.inspect
docker.logs
docker.stats
host.memory
host.load
host.disk
http.probe
```

Do **not** provide generic command/shell execution.

Every request must be bounded:

- container allowlist or configured target set
- log max lines and max bytes
- HTTP timeout
- host/path restrictions
- response size cap

Preferred Docker access: Docker Engine API client. If direct `docker.sock` is used in MVP, document its root-equivalent security risk and keep API read-only.

## Acceptance

Against a local/test Docker engine, retrieve inspect, bounded logs and stats for an allowlisted container; reject an unlisted container and unknown query type.

Stop and report.

---

# Milestone 5 — Docker lifecycle event source

## Goal

The node agent listens to Docker events and converts high-value transitions into shared `OpsEvent` objects sent to the central agent.

Minimum event categories:

```text
container die
container oom
container restart/start after failure
health_status: unhealthy
health_status: healthy (recovery correlation)
```

Do not send every Docker event.

When a significant event occurs, enrich only lightweight deterministic fields before push, for example:

- container name/id
- image
- exit code
- OOMKilled when available
- restart count
- node id

Detailed logs/stats remain on-demand Evidence.

Sender requirements:

- bounded queue
- timeout
- small retry budget
- central-agent outage must not crash/block node agent
- dropped-event counter/logging

## Acceptance

Start/stop a disposable test container and verify central Event Store receives the expected lifecycle event.

Stop and report.

---

# Milestone 6 — Host/OOM/health event detectors

## Goal

Add low-cost node-level observation without deploying a full metrics stack.

Minimum detectors:

```text
host memory pressure
host disk pressure
Docker OOM signal
configured HTTP health transition
```

Use duration/hysteresis rather than firing on a single sample where appropriate.

Health target configuration must be explicit and versionable through runtime config.

## Acceptance

- health target changes 200 -> failure -> 200 and produces one OPEN/relevant event plus recovery
- disposable memory-limited container OOM produces an OOM event
- agent does not flood identical events each polling interval

Stop and report.

---

# Milestone 7 — Evidence orchestration in central agent

## Goal

For an Incident, the central agent chooses deterministic evidence queries based on incident type and calls the correct node agent.

Do not use Pi/LLM yet.

Example mapping:

```text
container.oom
  -> docker.inspect
  -> docker.stats
  -> docker.logs(last bounded window)
  -> host.memory

container.die
  -> docker.inspect
  -> docker.logs

health.failure
  -> http.probe
  -> docker.inspect if target maps to container
  -> docker.logs when useful
```

Persist each returned Evidence separately from Event and Incident.

Failure to collect one evidence item must be represented explicitly and must not discard the Incident.

## Acceptance

A synthetic OOM/die incident results in a persisted evidence set without invoking any model.

Stop and report.

---

# Milestone 8 — DataAsset event transport integration contract

## Goal

Connect the already-implemented DataAsset RecordingStream output to central `POST /v1/events`.

The implementation work may require changes in the DataAsset repository, but this Pi-Ops repository owns the wire contract and integration fixture.

Expected DataAsset-side transport characteristics:

```text
RecordingStream handler
  -> normalize/filter/aggregate
  -> bounded non-blocking queue
  -> async batch HTTP sender
  -> pi-ops-agent
```

Hard rule: JFR handler/business thread never blocks on network I/O. Queue full must fail open for the application.

Do not forward every raw ExecutionSample/JFR event. High-frequency JFR data must be filtered/aggregated before transport.

## Acceptance

A real or fixture DataAsset JFR event reaches central Event Store and forms/updates an Incident.

Stop and report.

---

# Milestone 9 — FakeReasoner first, then PiReasoner interface

## Goal

Define a model-independent reasoning boundary only after Incident + Evidence work.

Interface concept:

```ts
interface ReasoningResult {
  hypothesis: string;
  confidence: number;
  reasoningSummary: string;
  recommendedActions: string[];
  needHuman: boolean;
  missingEvidence: EvidenceRequest[];
}

interface PiReasoner {
  analyze(input: IncidentContext): Promise<ReasoningResult>;
}
```

First implement a deterministic `FakeReasoner` for integration tests.

The orchestrator must be able to:

1. build IncidentContext
2. call reasoner
3. persist model output separately from Evidence
4. request one bounded extra evidence round when `missingEvidence` is returned
5. enforce an evidence-query budget to prevent loops

## Acceptance

End-to-end reasoning workflow works with FakeReasoner and zero external model calls.

Stop and report.

---

# Milestone 10 — Pi SDK reasoning

## Goal

Implement the real Pi SDK adapter behind the `PiReasoner` interface.

Requirements:

- model/provider configuration externalized
- timeout/retry bounded
- token/context budget configured
- no secret in logs
- prompt contains structured Incident + Evidence, not unbounded raw logs
- output validated against schema
- model outage leaves Incident/Evidence pipeline operational

The model may propose `missingEvidence` only from an allowlisted typed evidence catalog. It cannot produce arbitrary commands.

## Acceptance

Given the same fixture Incident, FakeReasoner and PiReasoner can be swapped by configuration without changing incident/evidence code.

Stop and report.

---

# Milestone 11 — Notification and recovery semantics

## Goal

Add WeCom notification only for incidents that policy/model marks as requiring human attention.

Rules:

- one OPEN incident should not repeatedly notify for every duplicate event
- notification includes facts, hypothesis/confidence, recommendations and incident id
- RECOVERED sends one recovery message when configured
- notifier failure does not lose Incident state

## Acceptance

Repeated event flood produces at most one initial notification for the same incident, then one recovery notification.

Stop and report.

---

# Milestone 12 — Deployment + two-node end-to-end validation

Infrastructure deployment configuration belongs in `josheee1117/test-infra`; this repository owns Dockerfiles/application runtime artifacts.

Target topology:

```text
test-svc-02
  pi-ops-agent
  pi-ops-node-agent
  DataAsset
  DataEase/MySQL/Nginx

test-ai-01
  pi-ops-node-agent
  RAGFlow/ES/Redis
```

Central agent must know node-agent endpoints/identities through configuration, not hard-coded source code.

## Required E2E scenarios

### S1 DataAsset white-box event

```text
RecordingStream/JFR -> Event -> Incident -> Evidence -> Reasoner
```

### S2 Third-party container die

```text
disposable/third-party container die
-> node-agent event
-> central Incident
-> inspect + logs Evidence
-> Reasoner
```

### S3 OOM

```text
memory-limited disposable container OOM
-> OOM Incident
-> Docker + Host Evidence
-> Reasoner identifies container-level vs host-level pressure
```

### S4 Health failure and recovery

```text
200 -> persistent failure -> OPEN
failure -> 200 -> RECOVERED
```

### S5 Event flood

```text
100 duplicate errors/events -> one Incident, bounded model/notification calls
```

### S6 Central model/API outage

```text
Pi/model unavailable
-> event ingestion, persistence, Incident and Evidence continue
-> DataAsset/node-agent remain healthy
```

## v0.1 Definition of Done

- both white-box and black-box event paths work
- two node agents can identify themselves and answer typed evidence requests
- no arbitrary shell endpoint exists
- event/incident/evidence/model-output separation is persisted
- OOM and container die scenarios are genuinely tested
- central/model outage is fail-safe for application/node collection
- secrets are not committed
- tests/typecheck pass
- deployment artifacts are ready for `test-infra`
- README documents how to run agent and node-agent locally

Only after this DoD should v0.2 consider controlled remediation such as restart/reload through policy-gated typed actions.
