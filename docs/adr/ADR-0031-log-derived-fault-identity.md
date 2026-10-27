# ADR-0031: 从容器日志还原的故障使用服务身份

- **Status**: Accepted
- **Date**: 2026-10-22
- **Scope**: Node Agent 容器日志发现产出的 `OpsEvent` 用什么身份进入 Incident 指纹
- **Supersedes**: none
- **Related**: ADR-0030, ADR-0001

## Context

2026-10-22 的真实 W2 演练（`deploy/local/fault-drills.py`，run `20261022-023023-14895c`）一次 `java.lang.OutOfMemoryError` 产生了两个 `jvm.oom` Incident 和两条 `INCIDENT_OPEN`：

- `order-service-本地演练-…`，来自应用自己的 EventBatch（`source: "jfr"`，事件 `4cf16029-…`）。
- `order-local-drill-…`，来自 Node Agent 的容器日志扫描（事件 `0a4b55b7…`）。

`computeFingerprint` 只把 `jvm.oom` 的 `source` 归一为 `application`，其余维度是 `nodeId`、`service`、`type`。两条事件的 `nodeId` 和 `type` 相同，只有 `service` 不同，所以指纹不同，Incident 不合并。日志路径的 `service` 当时直接取容器名（`createLogDetector` 构造 `LogScanSource` 处），因为日志行本身不带服务名。

这不是演练特有的问题。任何服务名与容器名不同的部署，只要同时开着应用 sender 和容器日志扫描，同一个故障就会以两个身份上报；而只开日志扫描的部署会把容器名当成服务名写进通知。

## Decision

1. 日志还原的故障携带**容器所属服务的身份**，不携带容器名。容器到服务的绑定只从 `PI_OPS_HEALTH_TARGETS` 里已声明的 `container` 字段取，取对应条目的 `name`（健康检测器本来就把 `name` 当作 `service`）。没有声明绑定就退回容器名，与当前行为一致。
2. 容器名继续留在 `attributes.containerName`。证据采集按这个属性定位容器（`apps/agent/src/evidence-orchestrator.ts`），所以身份换了，取证目标不变。
3. `jvm.oom` 的指纹保持**服务级**，不改成容器级。同一服务的多个副本在同一窗口内 OOM 合成一个 Incident，比按容器拆成多条告警更符合 ADR-0030「按故障影响决定通知」的方向；ADR-0030 已经把操作名和健康目标身份纳入指纹，这里补的是**生产者必须先把身份说对**，不是在指纹里加容器维度。
4. 引用在引号里的类名（JSON 载荷字段、JSON 编码的栈）不算栈头。这类行不产生故障事件，避免同一次 OOM 由一个结构化载荷行再生成一条没有栈帧的事件。
5. 中央通知事实（`apps/agent/src/notification-stored-facts.ts` 的 `exceptionObservation`）对 docker 来源的 `jvm.oom` / `jvm.stack_overflow` **不比较** `attributes.containerName` 与 `incident.service`。第 1 条把日志事件的 `service` 换成了服务名，容器名与它不同是常态，拿容器名否决就是丢掉整条 OOM 观察，只开日志扫描的部署发生真实 OOM 不再告警，违反 ADR-0030 第 1 条。事件自己声明的 `attributes.service` / `attributes.nodeId` 与 Incident 冲突时仍然否决；容器名只留在属性里给取证用。`container.oom` / `container.die` 的同一检查不变，那两条事件的 `service` 仍然是容器名。

## Consequences

- 同一个真实故障经两条路径到达时，指纹相同，合并成一个 Incident 和一条首次通知。
- 只开日志扫描的部署需要在健康目标里声明 `container`，否则服务身份仍是容器名。这是已知边界，不是隐藏行为。
- 通知事实层里还有一处按「容器名等于服务名」匹配：`notification-stored-facts.ts` 的 docker inspect OOMKilled 分支要求 `evidence.data.Name` 等于 `/${incident.service}`。第 1 条之后这条匹配对日志还原的故障不再命中，OOM 观察只能来自事件本身。仍未修，另议。
- 应用日志用 JSON 编码把整个栈写在一行（例如 `"stack_trace":"java.lang.OutOfMemoryError: …"`）时，当前识别不出这次 OOM。这类部署要先用同一条校验补一个 JSON 感知的提取器。
