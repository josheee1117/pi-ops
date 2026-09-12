# Pi-Ops documentation

## 1. Current architecture

Pi-Ops is an event-driven operations platform with **dual-source observation**: source-controlled
applications push high-semantic OpsEvents (DataAsset RecordingStream/JFR), while third-party services
are observed deterministically by a node agent (Docker / host / logs / health). Deterministic
collectors detect events, incidents aggregate them, evidence is collected on demand, and only then
does a bounded reasoning plane run over the evidence.

```text
Source-controlled application                     Third-party / black-box services
DataAsset RecordingStream/JFR                     Docker / Host / Logs / Health
             │                                                │
             │ high-semantic OpsEvent                         │ node observer event
             └───────────────────┐                  ┌─────────┘
                                 ▼                  ▼
                              pi-ops-agent
                    Event / Incident / Evidence / Evidence orchestration
                                  │
                    InvestigationContext (frozen, model-safe)
                                  ▼
                              pi-runtime
                       Coordinator → specialists → synthesis
                                  │
                            InvestigationReport
                                  ▼
                     Notification / Memory / audit
```

| Service | Owns | Must never |
|---------|------|-----------|
| `apps/agent` (pi-ops-agent) | event ingress, Incident lifecycle, evidence orchestration, Investigation lifecycle, notification, audit, memory governance | call a model, run shell, restart containers, write outside its SQLite |
| `apps/node-agent` | deterministic per-host observation and typed read-only evidence (`docker.*`, `host.*`, `http.probe`) | reason, call a model, accept model-supplied targets |
| `apps/pi-runtime` | bounded coordinator/specialist investigation and synthesis over a frozen context | reach Docker/JVM/host, run shell, write to Pi-Ops storage |
| `packages/protocol` | the single shared wire contract: OpsEvent, Evidence, investigation runtime | depend on any app |

Reasoning plane ownership is fixed by ADR-0029: `apps/pi-runtime` is the only component that calls a
model. `reasonerType=fake` is deterministic-only and never calls one.

## 2. ADR index

| # | Title | Status |
|---|-------|--------|
| 0001 | Dual-source node agent architecture | Accepted |
| 0006 | Reasoning memory foundation | Accepted |
| 0008 | Reasoning strategy boundary | Accepted |
| 0009 | Memory governance | Accepted |
| 0010 | Memory retrieval boundary | Accepted |
| 0011 | Reasoning delegation contract boundary | Superseded by 0029 |
| 0012 | Pi Runtime delegation contract | Superseded by 0029 |
| 0013 | Delegated reasoning result ingestion | Superseded by 0029 |
| 0014 | Delegation lifecycle | Superseded by 0029 (DelegationTask entity retained) |
| 0015 | Reasoning quality evaluation | Accepted |
| 0016 | Memory feedback loop | Accepted |
| 0017 | Memory intelligence phase | Accepted |
| 0018 | Pi Runtime investigation loop | Accepted |
| 0019 | Pi Runtime production contract | Accepted |
| 0020 | Investigation quality governance | Accepted |
| 0021 | Investigation knowledge graph | Accepted |
| 0022 | Evidence intelligence | Accepted |
| 0023 | Investigation knowledge graph (Phase 8) | Accepted |
| 0024 | Operational knowledge retrieval | Accepted |
| 0025 | External bounded multi-agent runtime | Accepted |
| 0026 | Typed read-only evidence enrichment | Accepted |
| 0027 | Durable operational notification delivery | Accepted |
| 0028 | JFR semantic evidence bridge | Accepted |
| 0029 | Reasoning plane consolidation | Accepted |

Numbers 0002–0005 and 0007 are unused; they were never written.

## 3. Other documents

- `plans/PLAN-0001-dual-source-v0.1-implementation.md` — v0.1 scope and Definition of Done status
- `plans/PLAN-0002-architecture-consolidation.md` — current milestone plan (M1–M10)
- `evolution/timeline.md` — what shipped, in order
- `evolution/phase12-local-work-log.md` — Phase 12 local integration log
- `local-integration.md` — running the local stack
- `testing/test-strategy.md` — what each test layer is for
- `testing/test-case-matrix.md` — scenario → invariant coverage
- `testing/test-gap-report.md` — open Evidence gaps

Governance tooling lives in `tools/test-governance/`; see its `README.md`. Repository-wide
conventions (merge rule, language defaults) are in `CONTRIBUTING.md`.
