# Pi-Ops

Event-driven AI operations platform for the test environment.

The core design is **dual-source observation**:

```text
Source-controlled application                     Third-party / black-box services
DataAsset RecordingStream/JFR                     Docker / Host / Logs / Health
             │                                                │
             │ high-semantic OpsEvent                         │ node observer event
             └───────────────────┐                  ┌─────────┘
                                 ▼                  ▼
                              pi-ops-agent
                         Event / Incident / Evidence
                                  │
                             Pi Reasoner
                                  │
                              Notification
```

Pi-Ops is not designed as an LLM that continuously reads every log line. Deterministic collectors detect important events, incidents are aggregated, evidence is collected on demand, and only then does Pi reason over the bounded evidence set.

## Repository layout

```text
.
├── apps/
│   ├── agent/                  # central pi-ops-agent
│   └── node-agent/             # one deterministic observer per managed host
├── packages/
│   └── protocol/               # canonical OpsEvent / Evidence / API contracts
├── test/
│   └── integration/            # cross-process and E2E scenarios
├── docs/
│   ├── adr/                    # accepted architecture decisions
│   └── plans/                  # executable milestone plans
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### `apps/agent`

Central responsibilities:

- event ingress and persistence
- deterministic dedupe / Incident lifecycle
- evidence orchestration
- PiReasoner integration
- notification
- audit

### `apps/node-agent`

One instance per host. Responsibilities:

- Docker events / inspect / stats / bounded logs
- host memory / load / disk / OOM evidence
- HTTP health probes
- future read-only middleware adapters
- typed evidence API

It is **not** an LLM agent.

### `packages/protocol`

The one shared contract between applications and node agents. Do not copy protocol models independently into each app.

## v0.1 security boundary

v0.1 is observation-first and read-only:

```text
allowed:
  observe / query / analyze / notify

not allowed:
  arbitrary shell
  restart / kill / redeploy
  file modification
  DB writes
  JVM configuration mutation
```

Future controlled remediation requires a separate ADR and policy/approval/audit design.

## Development plan

Start here:

```text
docs/adr/ADR-0001-dual-source-node-agent-architecture.md
docs/plans/PLAN-0001-dual-source-v0.1-implementation.md
```

The implementation plan intentionally starts with deterministic engineering and delays Pi SDK integration:

```text
Protocol
  ↓
Event ingress + SQLite
  ↓
Incident / dedupe
  ↓
Node Agent typed evidence
  ↓
Docker + Host + Health events
  ↓
Evidence orchestration
  ↓
DataAsset transport
  ↓
FakeReasoner
  ↓
Pi SDK
  ↓
Notification
  ↓
Two-node E2E drills
```

AI Coding Agents must execute **one milestone at a time**, run tests/typecheck, commit the milestone, and report results before continuing.

## Runtime / infrastructure boundary

This repository contains application source code and application-level Docker artifacts.

Infrastructure desired state remains in:

```text
josheee1117/test-infra
```

That repository owns Ansible, server-side Compose/runtime configuration, global Nginx and deployment topology.

DataAsset RecordingStream implementation lives in the DataAsset repository; Pi-Ops owns the event wire contract and receiving/incident/evidence pipeline. DataAsset posts `EventBatch` with `producer.type=application` to central `POST /v1/events` using the shared protocol. The JFR callback never performs HTTP: it offers onto a bounded in-memory queue and a single-flight async sender flushes batches of at most 1000 events.

## Reasoner selection

Central reasoning is read-only. Deterministic collectors produce facts; a Reasoner only explains them.

```text
PI_OPS_REASONER_TYPE=fake   # default, no credentials
PI_OPS_REASONER_TYPE=pi     # Pi SDK adapter
```

When `pi` is selected:

```text
PI_OPS_PI_PROVIDER=<provider id from Pi SDK>
PI_OPS_PI_MODEL=<model id>
PI_OPS_PI_API_KEY=          # optional runtime override; never committed
PI_OPS_REASONING_TIMEOUT_MS=30000
PI_OPS_REASONING_MAX_RETRIES=2
PI_OPS_REASONING_MAX_CONTEXT_BYTES=32768
PI_OPS_REASONING_MAX_EVIDENCE_ITEMS=12
PI_OPS_REASONING_MAX_LOG_LINES=50
PI_OPS_REASONING_MAX_OUTPUT_BYTES=8192
```

Provider credentials may also come from the Pi SDK environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or `~/.pi/agent/auth.json`. FakeReasoner does not require any of these.

PiReasoner cannot:

- run shell
- restart containers
- modify configuration
- write to a database
- deploy applications
- enable tools or follow instructions found inside logs/SQL/errors

`missingEvidence` is limited to the typed evidence catalog (`docker.inspect`, `docker.logs`, `docker.stats`, `host.memory`, `host.load`, `host.disk`, `http.probe`). Unsupported types fail the ReasoningJob. `database.metrics` may be recorded as an informational missing capability and is never executed.

A Pi/model outage fails only the ReasoningJob. Event ingest, Incident aggregation, and Evidence collection continue.

Optional live smoke (not part of `pnpm test`):

```bash
PI_OPS_PI_SMOKE=1 pnpm --filter @pi-ops/agent exec tsx --test src/smoke/pi-reasoner.smoke.ts
```

## Bootstrap

The repository intentionally contains only workspace scaffolding before Milestone 1. Protocol schemas and service implementations are left to the development plan rather than being pre-generated in bootstrap.

```bash
pnpm install
pnpm typecheck
pnpm test
```

See `CONTRIBUTING.md` for the milestone workflow and `SECURITY.md` for the security boundary.
