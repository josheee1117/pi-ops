# ADR-0001: Dual-source Pi-Ops architecture

- **Status**: Accepted
- **Date**: 2026-08-20
- **Scope**: Pi-Ops v0.1 event sources, central reasoning, per-node observation, and permission boundary
- **Upstream decision source**: `josheee1117/test-infra` ADR-0005

## Context

Pi-Ops must operate both source-controlled applications and third-party/black-box services.

DataAsset can emit high-semantic JFR/RecordingStream events from inside the JVM. Other services such as DataEase, RAGFlow, Elasticsearch, Redis, MySQL and Nginx cannot depend on source modification.

A single ingestion model is therefore insufficient.

## Decision

Pi-Ops uses two event-source classes feeding one incident/evidence pipeline.

```text
White-box source
DataAsset RecordingStream / application OpsEvent
                    |
                    | async batch HTTP
                    v
             +---------------+
             | pi-ops-agent  |
             | Event Store   |
             | Incident      |
             | Evidence      |
             | Pi Reasoner   |
             | Notification  |
             | Audit         |
             +-------+-------+
                     |
             typed evidence query
           +---------+---------+
           v                   v
  pi-ops-node-agent    pi-ops-node-agent
    test-svc-02          test-ai-01
           |                   |
  Docker/Host/Logs     Docker/Host/Logs
  Health/Adapters       Health/Adapters
```

### `pi-ops-agent`

Central responsibilities:

- HTTP event ingress
- schema validation
- event persistence
- dedupe and incident lifecycle
- evidence orchestration
- model reasoning through a `PiReasoner` abstraction
- notification
- audit

It does **not** perform raw host collection itself and does not expose an arbitrary shell execution interface.

### `pi-ops-node-agent`

One instance per managed node. Responsibilities:

- Docker event stream
- Docker inspect/stats/logs
- host memory/load/disk/OOM evidence
- HTTP health probes
- read-only middleware adapters
- typed evidence queries from the central agent

The node agent is a deterministic observer, not an LLM agent.

## Event strategy

Pi-Ops is event-driven rather than continuous full-log streaming.

Typical triggers:

- application/JFR anomaly event
- container die/restart/OOM
- health transition
- persistent resource pressure
- selected ERROR/FATAL patterns

After a trigger becomes or joins an Incident, the central agent requests only the evidence needed for diagnosis.

```text
Event Push
   +
On-demand Evidence Pull
```

Raw INFO logs are not continuously forwarded to the central agent.

## Capability depth

```text
Third-party container
  Docker + Host + Logs + Health

Third-party Java container
  above + optional JVM/JFR/JMX read-only evidence

Source-controlled Java application
  above + custom JFR events + trace/business/dependency semantics
```

All sources converge to the same `OpsEvent -> Incident -> Evidence -> Reasoner` model.

## Permission boundary

v0.1 is read-only:

- no arbitrary shell
- no restart/kill/redeploy
- no file modification
- no DB writes
- no JVM configuration changes
- no privileged root agent

Node capabilities must be typed, for example:

```json
{
  "query": {
    "type": "docker.logs",
    "container": "dataease",
    "since": "2m",
    "maxLines": 200
  }
}
```

Never expose a generic payload such as `{"command":"..."}`.

## Repository boundary

This repository is the Pi-Ops application source repository and uses a TypeScript monorepo:

```text
apps/agent
apps/node-agent
packages/protocol
```

Infrastructure desired state, Compose deployment and Ansible remain in `josheee1117/test-infra`.

## Consequences

Benefits:

- third-party services are first-class citizens without source changes
- DataAsset still benefits from deeper white-box telemetry
- Pi receives curated evidence instead of raw telemetry firehoses
- collection, policy and reasoning remain independently testable
- future controlled write operations can be added behind typed policy gates without redesigning ingestion

Costs:

- two runtime components must be deployed and versioned
- a stable shared protocol is required
- node-agent evidence APIs require careful allowlisting and limits

## Supersession rule

If future implementation requires changing the dual-source or permission model, create a new ADR rather than silently changing this document.
