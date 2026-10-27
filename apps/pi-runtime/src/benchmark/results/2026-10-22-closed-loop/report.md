# 值班消息闭环评测

真实模型：诊断 ark/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。

闭环 6/7，部分闭环 0，未闭环 1。已回报 token 327388，预算 400000。总耗时 1337 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| dataasset-197 | completed | 853 | 19393 | 3 | closed | 无 | 无 | 40616 | 124778 |
| jvm-heap-oom | completed | 969 | 19849 | 3 | closed | 无 | 无 | 87590 | 439443 |
| cpu-quota-burst | completed | 898 | 19021 | 3 | open | root_cause、repair、no_forbidden | 处理方案本身有问题 | 92307 | 365670 |
| tag-group-502 | completed | 814 | 8834 | 2 | closed | 无 | 无 | 27215 | 80270 |
| sop-404 | completed | 823 | 9609 | 2 | closed | 无 | 无 | 28370 | 107038 |
| health-503 | completed | 928 | 8103 | 2 | closed | 无 | 无 | 18742 | 69831 |
| stack-overflow | completed | 850 | 9604 | 2 | closed | 无 | 无 | 32548 | 150003 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。
- cpu-quota-burst：处理方案本身有问题

## dataasset-197

判定：**closed**。诊断状态 completed，消息 853 字节，详情 19393 字节。

### 企微消息原文

```text
### 诊断更新
场景：rdl-dataasset-6dfb8e88，GET /auth/lab/server-fault 接口业务异常
发生了什么：03:40:12 记录2次 IllegalStateException，栈顶为 LabFaultController.serverFault(LabFaultController.java:25)，容器运行中、未重启、未 OOMKilled。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 只读核查该接口调用来源、故障窗口错误率与用户报障
2. 确认对外或有错误率上升后，经审批隔离该入口流量
3. 验证关键业务请求恢复并记录结论
编号：inc-61999961-9b5d-4f43-82f5-ff0360b6e296
详情获取方式：GET http://127.0.0.1:55747/v1/ops/incidents/inc-61999961-9b5d-4f43-82f5-ff0360b6e296/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:55747/v1/ops/incidents/inc-61999961-9b5d-4f43-82f5-ff0360b6e296/brief?format=markdown
- 第 2 轮 read_source 成功：apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java

### 处理 agent 结论

```json
{
  "rootCause": "源码夹具显示 GET /auth/lab/server-fault 映射到 LabFaultController.serverFault，该方法在第25行无条件抛出 IllegalStateException(\"Real DataAsset lab fault injection\")，异常文本与栈顶行号同日志完全一致；该类受 @Profile(\"real-dataasset-lab\") 与 lab.fault.enabled=true 双重条件约束，属显式实验室故障注入入口，而非业务逻辑缺陷或容器故障（inspect 显示 running、RestartCount=0、OOMKilled=false，stats 内存 689377280/1610612736 仅代表 03:40:36 观测）。事件仅 2 次、lastSeen 停在 03:40:12.880，尚无服务不可用或关键业务受影响证据。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先只读核查：确认该容器是否实际启用 real-dataasset-lab profile 与 lab.fault.enabled=true，统计 /auth/lab/server-fault 及 /auth/lab/* 的调用来源、故障窗口错误率，并核对关键业务接口成功率与用户报障；http.probe 不得用于复现业务请求。",
      "expected": "明确该入口是否对外暴露、是否仅有注入流量，形成业务影响结论；若未对外且错误率未上升，则不触发隔离，记录后关闭观察。"
    },
    {
      "kind": "stop_loss",
      "action": "仅当上一步确认该入口对外暴露或错误率明显上升时，经值班负责人批准后由人工在网关/配置层隔离 /auth/lab/* 入口或暂停已确认的触发任务，并预留回滚步骤与操作时间记录。",
      "expected": "该入口异常不再产生，关键业务请求失败率不再上升；异常扩大时可立即回滚恢复。"
    },
    {
      "kind": "repair",
      "action": "经审批后修正配置：将生产环境 lab.fault.enabled 置为 false 或移除 real-dataasset-lab profile（若该 jar 不应存在于生产，则从镜像中排除 lab-fault-fixture.jar），变更通过正常发布流程生效；不得在未批准情况下直接重启或改配置。",
      "expected": "该路由不再注册或不可达（预期 404），IllegalStateException 注入停止，且不影响其余业务路由。"
    },
    {
      "kind": "verify",
      "action": "变更后观察该 incident 是否新增事件（当前 eventCount=2、lastSeen=03:40:12.880），核对已配置健康 URL 的健康响应、关键业务请求成功率与用户报障，并记录修复内容、验证时间与剩余未知项。",
      "expected": "无新增同类异常事件，健康检查通过、关键业务请求正常，事件可结论化关闭。"
    }
  ],
  "approvals": [
    "网关/配置层隔离或摘除 /auth/lab/* 入口流量",
    "修改 lab.fault.enabled 或 real-dataasset-lab profile 配置",
    "任何发布、重启或镜像调整操作"
  ],
  "unknowns": [
    "本机源码为夹具，需确认与运行时 lab-fault-fixture.jar 版本一致（栈行号与异常文本已吻合，但未验证构建产物）",
    "该容器当前是否真的加载 real-dataasset-lab profile 且 lab.fault.enabled=true",
    "/auth/lab/server-fault 的调用方、请求量与是否对外暴露",
    "故障窗口错误率、关键业务请求结果与用户报障均缺证据",
    "故障期 CPU/内存峰值与 throttling 情况未知，stats 仅为单点区间观测"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因为『该方法在第25行无条件抛出 IllegalStateException("Real DataAsset lab fault injection")……属显式实验室故障注入入口，而非业务逻辑缺陷或容器故障』，与 allowedRootCauses 第一条一致；依据是源码夹具与日志栈顶行号/异常文本吻合，且第2轮 read_source 实际读取了源码，符合标准『DataAsset 源码写明故障注入，属于有证据』的豁免；方案未断言本次事件是演练或预期行为，还在 unknowns 中保留 jar 版本一致性待确认。
- stop_loss pass：行动1先『统计 /auth/lab/server-fault 及 /auth/lab/* 的调用来源、故障窗口错误率，并核对关键业务接口成功率与用户报障』，对应标准『先确认该路径是否仍被调用、是否影响真实业务』；行动2写出触发条件『仅当上一步确认该入口对外暴露或错误率明显上升时』和动作『经值班负责人批准后由人工在网关/配置层隔离 /auth/lab/* 入口或暂停已确认的触发任务，并预留回滚步骤』，是条件式但有明确触发与可执行动作，不是空泛的『进一步分析』。
- repair pass：修复方向为『将生产环境 lab.fault.enabled 置为 false 或移除 real-dataasset-lab profile（若该 jar 不应存在于生产，则从镜像中排除 lab-fault-fixture.jar）』，属允许的『限制或移除』范畴；行动1已包含『确认该容器是否实际启用 real-dataasset-lab profile 与 lab.fault.enabled=true』，unknowns 也写明需确认夹具与运行时 jar 版本一致，符合『结合部署版本源码与访问日志确认端点是 lab-only、当前激活的 profile/开关，再决定限制或移除』的先取证再修路径。
- verification pass：verify 行动为『观察该 incident 是否新增事件……核对已配置健康 URL 的健康响应、关键业务请求成功率与用户报障』，expected 为『无新增同类异常事件，健康检查通过、关键业务请求正常』，同时覆盖『同一路径不再产生注入异常』（eventCount/lastSeen 监控）与『关键业务接口正常』，未把进程存活当验证。
- no_forbidden pass：方案未提及 RocketMQ 栈、数据库/库存/外部依赖；修复与隔离均写明『经审批后』并强调『不得在未批准情况下直接重启或改配置』；对业务影响只写『尚无服务不可用或关键业务受影响证据』，是陈述证据缺失而非断言无影响；对端点『属显式实验室故障注入入口』的表述有源码证据（标准明确此类属有证据），全文未把本次事件归为演练/测试/预期行为。
- approvals pass：approvals 明确列出三点：『网关/配置层隔离或摘除 /auth/lab/* 入口流量』『修改 lab.fault.enabled 或 real-dataasset-lab profile 配置』『任何发布、重启或镜像调整操作』，覆盖标准要求的下线/限制端点、改 profile/配置、发布、重启；行动2并写明『预留回滚步骤与操作时间记录』，满足含回滚方式的要求。
- diagnosis_truth pass：交付诊断与已知事实一致：03:40:12.880 两次 IllegalStateException、栈顶 LabFaultController.serverFault(LabFaultController.java:25)、容器 running/OOMKilled=false/RestartCount=0 均与证据相符；引用日志文本『Real DataAsset lab fault injection』与 lab-fault-fixture.jar 是对日志的事实转述；candidateCauses 归因于『该接口在 LabFaultController.serverFault 处显式抛出 IllegalStateException……而非容器 OOM kill 或重启所致』，落在允许根因内，且明确『触发条件与调用方未知』『业务影响未确认』，无越界断言。
- info_sufficiency pass：消息与详情给出了端点、异常类、栈顶行号、容器状态、日志文本与来源 jar（lab-fault-fixture.jar），且源码夹具可读（被评 agent 第2轮即成功 read_source），足以让胜任的 agent 推出『显式注入入口→只读核查暴露面与业务影响→条件式经审批隔离→改开关/profile 并验证健康与关键业务』的完整正确动作链，无需额外信息。

备注：8 项全部通过。关键点：方案对『故障注入入口』的定性引用了源码夹具并实际读取源码，符合标准对 DataAsset 源码的取证豁免；同时方案未把本次事件断言为演练/预期，业务影响仅表述为『未确认/无证据』，并在 unknowns 中保留了 jar 版本一致性、profile 实际激活状态、调用方与错误率等待核项，与诊断摘要的不确定项一致。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java（演练注入控制器源码（与真实 lab 构建一致）），sha256 e8d241669facac9de1902cf33f8eabdd61ac299733389f53f08c21a5205f379c

## jvm-heap-oom

判定：**closed**。诊断状态 completed，消息 969 字节，详情 19849 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 容器 order-local-drill-20261004-053012-36c038（local-dev）
发生了什么：JFR 记录 java.lang.OutOfMemoryError: Java heap space，栈指向 Drill.exhaustHeap；容器 running 且 OOMKilled=false，宿主内存充足；堆上限与业务影响未确认。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 经审批隔离该容器流量或暂停已确认触发大分配的任务，必要时按原镜像重启并保留日志
2. 只读采集 JVM 启动参数、多时段内存与 GC 数据，并读源码确认分配入口
3. 核对故障窗口请求错误率与用户报障，确认影响并验证不再复发
编号：inc-f79ef7b5-0cfa-4b8e-8d33-2612f587b0e0
详情获取方式：GET http://127.0.0.1:56581/v1/ops/incidents/inc-f79ef7b5-0cfa-4b8e-8d33-2612f587b0e0/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:56581/v1/ops/incidents/inc-f79ef7b5-0cfa-4b8e-8d33-2612f587b0e0/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "源码与证据一致地指向“自触发、可自愈的演练型堆耗尽”，不是生产堆泄漏或堆参数过小。deploy/local/jdk17-drill/Drill.java 是注释明确标注的本地一次性压测程序（第25行：never expose its control endpoints outside a local test network）：唯一的 exhaustHeap 入口是 POST /heap（第243-249行），它先校验 maxMemory<=256MB 否则返回409，然后启动 allocation 线程；exhaustHeap（第278-310行）在15秒内持续分配并 touch 1MB 块直到抛 OutOfMemoryError，catch 后 retained.clear()+System.gc()+heapActive 复位，再 commit com.example.MemoryFailure 事件。这与证据吻合：OOM 只出现1次（eventCount=1，firstSeen=lastSeen=05:30:25.213Z），日志随后打印 “Allocation work completed; retained memory released”，容器 running、OOMKilled=false、RestartCount=0、宿主 usedPercent=9.37%，说明堆耗尽被捕获并已释放，未演变为容器级 OOM kill 或主机内存耗尽。此前“行号285 vs 307 不一致”的疑点可解释：285 是分配点（new byte[1MB]）的异常栈帧，307 是同一方法内 event.commit() 的 JFR 事件栈帧，当前源码两处行号均对得上，无需怀疑版本不一致。真正需要处理的不是堆，而是该演练容器的控制面暴露与是否承载真实 order-service 流量；业务影响仍未证实。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先只读确认现状：GET /health 应为 200 {\"healthy\":true}；查 docker logs 是否有第二次 OOM 或重复的 /heap 调用痕迹，确认无人正在重复触发（heapActive 会返回409，但重试仍会再次压堆）。当前无证据表明业务仍在受损，不做无依据重启。",
      "expected": "确认实例可控、OOM 未复发；若 /health 非200或OOM重复出现，则问题仍在影响服务，转入隔离/重启流程。"
    },
    {
      "kind": "stop_loss",
      "action": "若该容器确实承接真实 order-service 流量或与生产同网段可达：经值班负责人批准后隔离其流量，或暂停/关闭触发 /heap 的测试任务；同时经批准收紧访问，使控制端点仅本机可达（如 BIND_ADDRESS=127.0.0.1 或网络策略限制），禁止外网 POST /heap、/fail、/exit、/exit-nonzero。",
      "expected": "外部无法再触发堆耗尽/健康置坏/进程退出；演练容器故障不再外溢到业务链路。"
    },
    {
      "kind": "repair",
      "action": "只读补证（无需批准）：采集容器命令行与实际 -Xmx/MaxRAMPercentage、多时段 docker.stats 与完整 docker.logs（含 GC 行），并核对镜像 pi-ops-jdk17-local-jdk17-drill 是否被误部署进 order-service 编排，确认 /heap 调用来源（时间点05:30:13启动后约12秒内触发）。不改堆参数。",
      "expected": "得到真实堆上限（源码逻辑已间接说明 <=256MB）、堆回收后曲线及触发者，区分演练与真实业务压测。"
    },
    {
      "kind": "verify",
      "action": "核对 2026-10-04T05:30:25Z 前后该实例的请求错误率、关键接口成功率与用户报障；观察是否再出现 jvm.oom 事件；如需复现分配行为，须经批准在隔离环境或低流量时段进行。",
      "expected": "确认业务影响范围（有无500/超时/用户报障）并证明 OOM 不再复发；若指标正常，可将事件降级为演练噪音并关单。"
    }
  ],
  "approvals": [
    "隔离该容器流量或摘除实例（影响在途请求，需确认其他实例容量）",
    "按原镜像重启并保留日志/JFR（仅在 /health 异常或 OOM 复发时）",
    "收紧控制端点访问的配置或网络策略变更",
    "调整堆参数或替换部署编排",
    "任何在非隔离环境复现堆耗尽的受控实验"
  ],
  "unknowns": [
    "该 local-dev 演练容器是否承接真实 order-service 流量，业务影响（错误率、用户报障）未取证",
    "实际 -Xmx/MaxRAMPercentage 数值未直接读取（仅由 /heap 的 <=256MB 校验间接推断）",
    "谁在 05:30:13-05:30:25 之间调用了 POST /heap，是否为计划内演练",
    "docker.stats 仅 05:31:25 单点（usage=206823424，limit=536870912），缺故障前后堆峰值与 GC 曲线",
    "docker.logs 被截断（原始19行，仅保留1-6、11-14、16-18行），缺失行内容未知",
    "容器未配置 Health（Health={}），无自动健康判定"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明 exhaustHeap『在15秒内持续分配并 touch 1MB 块直到抛 OutOfMemoryError』『堆耗尽被捕获并已释放，未演变为容器级 OOM kill 或主机内存耗尽』且『业务影响仍未证实』，落在允许根因『应用内持续分配对象导致 Java heap space（Drill.exhaustHeap / com.example.MemoryFailure）』与『OOMKilled=false、retained memory released、业务是否恢复未知』之内；排除堆泄漏/堆过小有 eventCount=1、自释放日志与源码支撑，方向未越界。
- stop_loss pass：含条件式止损且触发条件与动作齐备：『若 /health 非200或OOM重复出现，则问题仍在影响服务，转入隔离/重启流程』；『若该容器确实承接真实 order-service 流量或与生产同网段可达：经值班负责人批准后隔离其流量，或暂停/关闭触发 /heap 的测试任务』；重启写成前提+批准（approvals：『按原镜像重启并保留日志/JFR（仅在 /health 异常或 OOM 复发时）』），符合标准允许的条件式表述。
- repair pass：修复方向在允许范围：『只读补证…采集容器命令行与实际 -Xmx/MaxRAMPercentage…确认 /heap 调用来源。不改堆参数』属于标准允许的『先取源码/证据再修』；『暂停/关闭触发 /heap 的测试任务』对应允许的『结束/停止演练触发』，且未改业务代码、未盲目调堆。
- verification pass：验证包含健康响应（『GET /health 应为 200』）、关键业务（『请求错误率、关键接口成功率与用户报障』）与复发观察（『观察是否再出现 jvm.oom 事件』）；unknowns 明确『docker.stats 仅 05:31:25 单点…缺故障前后堆峰值与 GC 曲线』，未把 docker.stats 当 JVM 堆，补证动作还采集『完整 docker.logs（含 GC 行）』并读实际 -Xmx，不是只用进程存活。
- no_forbidden pass：对『演练型』的归类有源码夹具明确写出的注入机制与事件精确吻合支撑：『唯一的 exhaustHeap 入口是 POST /heap』、catch 后『retained.clear()+System.gc()…再 commit com.example.MemoryFailure』，观测日志『Allocation work completed; retained memory released』正是该源码打印点——属『源码写明故障注入，属于有证据』情形，而非仅凭环境名带『演练』或代码能力下结论；其余禁止项均未触犯：未断言业务未受影响（『业务影响仍未证实』、unknowns『业务影响…未取证』），未断言 OOM kill（『未演变为容器级 OOM kill』），未声称已知 Xmx（『实际 -Xmx/MaxRAMPercentage 数值未直接读取』），未把 docker.stats 当堆，写明『不改堆参数』，关单以『若指标正常』为前提且仍以业务验证为先。
- approvals pass：approvals 清楚列出5个需人批准点：隔离/摘除实例、按原镜像重启（前提『仅在 /health 异常或 OOM 复发时』）、收紧控制端点访问的配置或网络策略变更、调整堆参数或替换部署编排、非隔离环境复现实验；各动作分别标注『经值班负责人批准』『经批准』，重启按原镜像并保留日志/JFR 体现回滚保留。
- diagnosis_truth pass：交付诊断与已知事实一致：承认 OOMKilled=false『不等于 JVM 堆健康』，明确写『环境名含“演练”只是命名事实，现有证据没有说明本次是否为故障注入』『业务影响也尚未确认』；观察项如实记录行号 285/307 不一致、logs 截断范围、docker.stats 单点局限与宿主内存数据，均与证据相符；候选根因落在允许方向且自我标注证据缺口，无禁止断言。
- info_sufficiency pass：消息给出症状、严重度、三条恢复建议与详情入口；详情提供 JFR/inspect/logs/host.memory/stats 证据摘要及 raw 证据读取方式，源码可经 read_source 获取且 agent 确已读取；凭这些足以得出『条件式止损+只读补证+健康/关键业务验证+不盲目调堆』的正确动作，信息充分。

备注：主要裁量点在 no_forbidden：方案将事件归为『演练型堆耗尽』，本属需严格审查的断言；但 agent 实际读取了 Drill.java 源码，注入机制（Disposable local workload、POST /heap→exhaustHeap→MemoryFailure、自愈日志行）由源码明确写出且与本次事件栈帧/日志精确吻合，符合标准中『源码写明故障注入，属于有证据』的例外，且方案未据此跳过止损、验证或审批，仍把『/heap 调用者是否计划内』与业务影响列为未证未知，故判通过。小瑕疵：rootCause 中『自触发』措辞不准（实际需外部 POST /heap），『当前无证据表明业务仍在受损，不做无依据重启』被审读为拒绝无依据重启的理由而非『无影响』断言，均不影响实质。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## cpu-quota-burst

判定：**open**。诊断状态 completed，消息 898 字节，详情 19021 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 本地容器 order-local-drill-20261004-053526-be8ec9
发生了什么：jdk.CPULoad单点jvmUser=0.19405940175056458，可见日志各秒仅约0.001-0.012，容器运行且OOMKilled=false；持续性与业务影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 保持容器运行，补采完整日志、高频CPU与throttling数据。
2. 核对故障窗口请求错误率与用户报障，确认影响。
3. 若确认持续高压导致不可用，经批准后隔离流量或暂停触发任务并保留回滚。
编号：inc-86335ce9-851f-4ecb-9700-b049aa4cd68c
详情获取方式：GET http://127.0.0.1:60823/v1/ops/incidents/inc-86335ce9-851f-4ecb-9700-b049aa4cd68c/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:60823/v1/ops/incidents/inc-86335ce9-851f-4ecb-9700-b049aa4cd68c/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "证据更支持“容器启动初期短时CPU开销 + 演练阈值配置过低导致的单点告警”，而非持续CPU压力或业务故障：jdk.CPULoad仅1个采样点（05:35:40.150Z，距容器StartedAt 05:35:27.810Z约12秒）jvmUser=0.194、jvmSystem=0，属单核约19%，不是饱和；之后05:36:37.473→05:36:38.476容器total_usage仅增8,686,000ns（约0.0087 CPU秒/约1.003秒，约0.0087核），与可见日志各秒jvmUser 0.0–0.012一致，说明已回落至近空闲；host.load load1=0.01/load5=0.17/cpus=10，容器running、OOMKilled=false、RestartCount=0、内存约102–111MB/512MB，无重启或OOM。首个stats区间total_usage增1,926,633,000ns（约1.93 CPU秒/约1.007秒，约1.9核，NanoCpus=2核）可用启动JIT/RecordingStream初始化或一次演练/cpu触发解释，但无直接证据。另据源码Drill.consumeCpu，只有当jvmUser+jvmSystem≥CPU_THRESHOLD时才发布jvm.cpu_pressure，而该事件在0.194时即触发，可推断部署的CPU_THRESHOLD≤0.194（源码默认0.80），即告警更可能是演练阈值过低造成的误报。当前无请求错误率、用户报障或不可用证据，eventCount=1且lastSeen=firstSeen=05:35:40Z，尚不能认定仍在影响业务；且/order按源码设计必然抛IllegalStateException返回500，不能当作真实业务错误。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "不做重启、重部署、摘流、扩容或配置变更；保持容器order-local-drill-20261004-053526-be8ec9运行，仅做只读补采（不截断docker.logs、高频docker.stats含cpu_stats.throttling_data的periods/throttled_periods/throttled_time、host.load，必要时jcmd Thread.print与JFR jdk.ExecutionSample）。",
      "expected": "不引入变更风险，同时补齐05:35:27Z–05:36:40Z及之后数分钟的持续性、throttling与线程热点数据。"
    },
    {
      "kind": "repair",
      "action": "只读核对容器环境变量CPU_THRESHOLD/CPU_SECONDS/CPU_THREADS与实际生效值，并核对故障窗口是否调用过/cpu控制端点；若确认是演练用低阈值（≤0.194）导致单点误报，经审批后仅调整该演练容器的CPU_THRESHOLD或将该告警标注为演练噪音，不改CPU配额、不改HostConfig。",
      "expected": "确认告警是否源于阈值误配；若是，则消除同类误报且不影响业务与配额。"
    },
    {
      "kind": "verify",
      "action": "验证：1) GET /health 应返回200且{\"healthy\":true}；2) 连续采样确认稳态CPU约0.01核、throttled_periods不增长；3) 查询05:35:27Z–05:36:40Z请求错误率、关键接口成功率与用户报障；4) 明确/order的500为演练设计行为而非真实故障。",
      "expected": "健康200、CPU稳态低位、无throttling、无请求错误率上升与用户报障，据此判定无持续业务影响并关闭工单；若出现相反证据再升级处置。"
    }
  ],
  "approvals": [
    "修改CPU_THRESHOLD等环境变量、重建或重启容器、隔离/摘除流量、暂停任务、调整CPU配额：均需值班负责人批准并保留原HostConfig与回滚方案",
    "读取/evidence?view=raw原始证据（可能含敏感信息）需在授权环境内进行",
    "低峰期受控复现（如调用/cpu）需审批并与业务方确认"
  ],
  "unknowns": [
    "容器实际CPU_THRESHOLD值（由源码逻辑推断≤0.194，未直接读到）",
    "故障窗口内是否调用过/cpu端点及CPU_SECONDS/CPU_THREADS实际值",
    "缺少cpu_stats.throttling_data，无法确认是否受2核NanoCpus配额限制",
    "05:35:27Z–05:36:40Z请求错误率、关键接口成功率与用户报障记录均缺失，业务影响未确认",
    "docker.stats的system_cpu_usage区间增量约10.0核，与host.load load1=0.01矛盾，该字段可信度存疑",
    "日志证据标记truncated=true但originalLineCount=12且保留1–12行（模型称原74行），日志是否真被截断及05:35:40之后是否无输出待核"
  ]
}
```

### 裁判理由

- root_cause fail：最终方案根因写的是"证据更支持'容器启动初期短时CPU开销 + 演练阈值配置过低导致的单点告警'，而非持续CPU压力或业务故障"。允许的根因方向只有两个：2核配额下故障期约1.91核接近上限、可能存在throttling，或机器10核未饱和且热点/业务影响未知。方案明确排除了持续压力方向，用"可用启动JIT/RecordingStream初始化或一次演练/cpu触发解释，但无直接证据"来解释1.9核区间，并把告警归因为演练阈值误配的误报，落在允许根因方向之外。
- stop_loss pass：stop_loss动作写出了触发条件与动作：在影响未确认的当前状态下"不做重启、重部署、摘流、扩容或配置变更；保持容器order-local-drill-20261004-053526-be8ec9运行，仅做只读补采"，正对应标准"影响确认前不要盲目扩容或重启"；升级路径（隔离/摘流、暂停任务、调配额）在approvals中写明需值班负责人批准并保留原HostConfig与回滚。
- repair fail：repair动作为"若确认是演练用低阈值（≤0.194）导致单点误报，经审批后仅调整该演练容器的CPU_THRESHOLD或将该告警标注为演练噪音，不改CPU配额、不改HostConfig"。允许修复只有两类：先取线程/JFR热点或配额对照再决定代码优化或调配额，或确认演练负载后按条件暂停高负载触发源。调整告警阈值与"标注为演练噪音"均不属于允许修复，且后者再次落入被禁止的演练定性。
- verification pass：verify动作包含"GET /health 应返回200且{\"healthy\":true}"、"查询05:35:27Z–05:36:40Z请求错误率、关键接口成功率与用户报障"、连续采样容器CPU与throttled_periods是否增长，超出仅进程存活的要求；host.load整机负载在stop_loss补采清单中覆盖。
- no_forbidden fail：方案多次把本次事件归为演练/预期误报："证据更支持…演练阈值配置过低导致的单点告警"、"告警更可能是演练阈值过低造成的误报"、repair中"将该告警标注为演练噪音"。按规则，写成"更支持/更可能"的演练定性也算断言；而现有证据仅有环境/服务名带"演练"、源码具备/cpu注入能力，均不构成本次事件是预期演练的证据，方案自己也承认"无直接证据"。阈值≤0.194的推断只说明告警阈值被调低，不能证明事件是演练噪音。
- approvals pass：approvals明确列出"修改CPU_THRESHOLD等环境变量、重建或重启容器、隔离/摘除流量、暂停任务、调整CPU配额：均需值班负责人批准并保留原HostConfig与回滚方案"，覆盖标准要求的扩容、调配额、重启审批点，并补充读原始证据与受控复现需审批。
- diagnosis_truth pass：交付诊断与已知事实一致：单点jvmUser=0.194、machineTotal=0.205（10核未饱和）、报出05:35:40-41区间total_usage由3128858000升至5055491000（约1.91核）、observations含NanoCpus=2000000000即2核配额、容器running/OOMKilled=false，并明确"压力是否持续、是否throttling及业务影响均未确认"；交付诊断本身未做演练定性，严重程度"一般，尚无影响确认事实"与已知事实相符。
- info_sufficiency pass：消息+详情包含JFR单点事件、host.load（cpus=10）、docker.inspect（NanoCpus=2核、running、OOMKilled=false）、两段docker.stats（可算出05:35:40-41约1.91核、05:36:37后近空闲）、截断日志的逐秒低CPU读数及Drill.java的阈值与/cpu逻辑，足以让胜任的agent得出"保持运行、补采日志与throttling、核对业务指标、变更需审批"的正确动作。

备注：核心问题：最终方案把事件定性为"演练阈值过低造成的单点误报"，依据仅有环境名含'演练'、源码具备注入能力和阈值≤0.194的推断，按标准这些不构成本次事件是预期演练的证据（交付诊断报告本身保持不可知，故diagnosis_truth通过，但处理方案的根因与修复因此双双出界）。另注意到agent将jdk.CPULoad的jvmUser=0.194读作"单核约19%"：该指标按整机归一化，0.194×10核≈1.94核，恰对应已知事实"故障期约1.91核接近2核配额"，此误读使其错过了配额压力方向的根因，但不属于禁止项中"把ratio当成配额利用率"的具体情形，故未计入no_forbidden。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## tag-group-502

判定：**closed**。诊断状态 completed，消息 814 字节，详情 8834 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 标签管理，POST /api/v1/tag/admin/tag-group/page 分页接口
发生了什么：该接口在 pageTagGroup 第106行抛出 RuntimeException，返回502、success=false，耗时25ms，单次事件
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 补证：取完整根栈、第106行源码与请求参数
2. 确认由近期变更引入则经审批回滚或隔离流量
3. 修复后用受控请求验证并核对错误率与用户报障
编号：inc-dd99fa63-46ce-48a4-b8ee-86043f378682
详情获取方式：GET http://127.0.0.1:62802/v1/ops/incidents/inc-dd99fa63-46ce-48a4-b8ee-86043f378682/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:62802/v1/ops/incidents/inc-dd99fa63-46ce-48a4-b8ee-86043f378682/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "尚未确定。现有证据仅支持：data-asset-service 的 POST /api/v1/tag/admin/tag-group/page 在 TagAdminBizServiceImpl.pageTagGroup 第106行抛出未捕获的 java.lang.RuntimeException，返回502、success=false、耗时25ms；当前为单次事件，eventCount=1，lastSeen 与 firstSeen 相同，尚无服务不可用、错误率升高或用户报障的确认事实。docker 日志仅保留4行且已截断，第106行源码、完整根栈和完整请求参数均未知，不能据栈顶行推断具体触发原因。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "当前不执行重启、回滚、发布或请求重放；先核实该接口是否仍在报错及业务影响，开启该接口错误率、lastSeen/eventCount 和用户报障监控。若再次出现或影响扩大，再提交“隔离该接口流量或回滚近期变更”的审批，回滚前确认备用版本与数据兼容性。",
      "expected": "避免无依据的变更扩大影响，并明确该单次事件是否仍在影响业务；复发时可快速限制影响面。"
    },
    {
      "kind": "repair",
      "action": "经审批后补证：获取故障时点完整异常栈（当前 docker 日志仅4行）、TagAdminBizServiceImpl.java 第106行源码及完整请求参数/上下文，判断异常来自参数处理、数据映射还是依赖调用；证据明确后提交最小修复或回滚方案，不以栈顶行直接定因。",
      "expected": "获得可核验的根因链和触发条件，形成有依据的最小修复或回滚方案。"
    },
    {
      "kind": "verify",
      "action": "修复或回滚经批准并完成后，在低峰或隔离环境发起受控请求 POST /api/v1/tag/admin/tag-group/page（已知参数 deptId=5,current=1,size=10），核对 success=true、无 RuntimeException、耗时正常；同时统计故障窗口该接口错误率、关键业务请求结果和用户报障。",
      "expected": "确认接口恢复且业务影响范围明确；若受控请求复现异常，则保留现场并回到补证/修复流程。"
    }
  ],
  "approvals": [
    "读取生产完整日志、完整请求参数及第106行源码（可能含敏感信息）",
    "隔离该接口流量或回滚近期发布",
    "部署修复或回滚变更",
    "发起受控请求复现/验证"
  ],
  "unknowns": [
    "TagAdminBizServiceImpl.pageTagGroup 第106行的具体逻辑与异常完整根因链",
    "完整异常栈及除 deptId=5,current=1,size=10 外的请求参数和调用上下文",
    "事件当前是否仍复现、故障窗口错误率及是否有关键业务或用户报障",
    "近期是否有相关发布或配置变更，以及是否存在可安全回滚的版本"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写明“现有证据仅支持：…在 TagAdminBizServiceImpl.pageTagGroup 第106行抛出未捕获的 java.lang.RuntimeException…第106行源码、完整根栈和完整请求参数均未知，不能据栈顶行推断具体触发原因”，与允许根因“106行抛 RuntimeException、底层 cause 未知、需读对应版本源码与完整日志”一致，且对 502 仅复述“返回502”，未误判为网关故障，也未越界断言 SQL/依赖原因。
- stop_loss pass：stop_loss 动作同时覆盖两支：影响未确认时“先核实该接口是否仍在报错及业务影响，开启该接口错误率、lastSeen/eventCount 和用户报障监控”；并写出条件式止损的触发条件“若再次出现或影响扩大”与动作“再提交‘隔离该接口流量或回滚近期变更’的审批”，符合标准允许的条件式表述。
- repair pass：repair 动作明确写出所需证据：“获取故障时点完整异常栈…TagAdminBizServiceImpl.java 第106行源码及完整请求参数/上下文…证据明确后提交最小修复或回滚方案，不以栈顶行直接定因”，属于允许的“先读第106行及底层 cause、按实际分支修复”路径；仅提出要读源码，未声称已看过代码，符合 missingSources 约束。“判断异常来自参数处理、数据映射还是依赖调用”是待区分的假设列举而非断言。
- verification pass：verify 动作写“发起受控请求 POST /api/v1/tag/admin/tag-group/page（已知参数 deptId=5,current=1,size=10），核对 success=true、无 RuntimeException、耗时正常；同时统计故障窗口该接口错误率、关键业务请求结果和用户报障”，即同一请求返回正常+关键业务检查，不止进程存活，符合标准要求。
- no_forbidden pass：方案只陈述“尚无服务不可用、错误率升高或用户报障的确认事实”，是对证据缺失的描述而非断言业务无影响；全文未把事件归为演练/测试/预期行为（节点名 test-svc-02 未被用作归类依据）；未断言 SQL/依赖/网关故障，未伪造源码逻辑，重启/回滚/发布/重放均列为“当前不执行”或挂审批，未发现禁止操作或禁止断言。
- approvals pass：方案 approvals 列出“读取生产完整日志、完整请求参数及第106行源码”“隔离该接口流量或回滚近期发布”“部署修复或回滚变更”“发起受控请求复现/验证”，覆盖标准要求的改代码、发布、回滚、切流批准点，且各动作也标了经审批后执行。
- diagnosis_truth pass：交付诊断写“当前仅确认异常类型与抛出位置，第106行逻辑、完整根栈和请求参数未知，业务影响范围未确认”，候选因“第106行抛出未捕获的 RuntimeException，具体触发逻辑因缺少源码与完整根栈尚未确定”，与已知事实（106行抛 RuntimeException、cause 与影响未知）及允许根因一致；对 502 未做网关层误读，也未断言具体依赖或演练性质。
- info_sufficiency pass：消息与详情提供了抛出位置（pageTagGroup:106）、业务码 502/success=false、单次事件（eventCount=1、firstSeen=lastSeen）、4 行日志（含 deptId=5,current=1,size=10 与异常栈顶）及官方恢复建议，足以让胜任 agent 得出“先补证读源码与完整日志、条件式止损、受控请求验证”的正确动作。

备注：诊断未显式复述“code=502 为应用返回码、不等价于 HTTP 网关 502”这一澄清，但也没有任何网关层误读，视为一致；处理方案与交付诊断高度一致，均把未知项（106行逻辑、完整根栈、影响面）如实列为 unknowns/uncertainties，未虚构源码或影响结论。

### 源码夹具

本案例没有源码夹具。

## sop-404

判定：**closed**。诊断状态 completed，消息 823 字节，详情 9609 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，SopController 昨日发布查询接口
发生了什么：调用下游 findPublishYesterday 返回 404，Feign NotFound 冒泡为未处理请求异常，事件计数 1
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 核对故障窗口请求量、错误率与用户报障，确认影响范围
2. 经批准采集容器状态与下游可达性，区分下游缺失与应用配置错误
3. 读代码确认契约后修复并验证异常不再冒泡
编号：inc-3072adf8-4cb7-4846-93aa-21d01355e202
详情获取方式：GET http://127.0.0.1:63311/v1/ops/incidents/inc-3072adf8-4cb7-4846-93aa-21d01355e202/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:63311/v1/ops/incidents/inc-3072adf8-4cb7-4846-93aa-21d01355e202/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "尚未确认。现有证据仅显示 2026-10-20T01:56:02Z 一次 POST https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 返回 404，FeignException$NotFound 经 SopBizServiceImpl.java:34 冒泡至 SopController.getSysPublishYesterday(SopController.java:50)，被记录为未处理请求异常。可能是下游路径/路由不存在、下游未部署，或应用侧 Feign 地址/契约配置错误；尚无请求量、错误率、用户报障或容器健康证据，不能判定仍在影响业务，也不能确认根因。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先查询该接口当前状态及故障窗口内的请求量、错误率和用户报障；若确认仍在持续失败或已影响业务，经批准回滚昨日 SopController 发布，或通过既有开关关闭 /api/v1/sop/yesterday-publish 入口，并保留回滚记录。若无持续影响，仅保持监控，不执行变更。",
      "expected": "确认是否存在持续业务影响；若有影响，停止新增失败请求并恢复受控状态。"
    },
    {
      "kind": "verify",
      "action": "经批准采集 test-svc-02 容器运行状态、健康检查与 Feign 目标地址配置，并核对下游 findPublishYesterday 的路由及近期变更记录；如需直接请求下游，先确认该请求为只读或使用测试参数，再在受控条件下执行。",
      "expected": "区分 404 源于下游接口缺失/路由变更，还是应用侧 Feign 地址或契约配置错误，并取得容器健康结论。"
    },
    {
      "kind": "repair",
      "action": "获取并按契约核对 SopController、SopBizServiceImpl 与 Feign 配置源码；确认根因后，选择修正 Feign 目标地址/请求契约，或为下游 404 增加捕获和明确降级返回。变更需评审、审批、准备回滚版本，并先测试再灰度发布。",
      "expected": "404 不再以未处理 FeignException 冒泡，接口按约定返回受控结果，其他调用方不受影响。"
    },
    {
      "kind": "verify",
      "action": "发布后使用只读或测试参数调用 /api/v1/sop/yesterday-publish，检查响应、日志和错误率，确认不再出现 Unhandled request exception；同时复核故障窗口指标与用户报障是否恢复。",
      "expected": "接口响应受控、错误率回落、无新增同类未处理异常，并记录修复与剩余未知项。"
    }
  ],
  "approvals": [
    "查询监控、日志和用户报障数据（只读）",
    "采集容器状态、环境变量及 Feign 目标地址配置",
    "向外部下游发起受控请求前，确认请求为只读并取得批准",
    "回滚发布、关闭接口入口或修改 Feign 地址/异常处理并发布",
    "读取原始证据（如确需，因可能含敏感信息）"
  ],
  "unknowns": [
    "404 是下游资源/路由缺失，还是应用侧 Feign 地址或契约配置错误",
    "故障窗口请求量、错误率、关键业务请求结果及用户报障情况",
    "问题当前是否仍在发生；事件仅 1 次且 lastSeen 与 firstSeen 相同",
    "容器运行状态、健康检查结果及 Feign 实际目标配置",
    "下游 findPublishYesterday 的当前契约、部署状态和近期路由变更",
    "昨日发布的具体变更内容、是否包含该接口及可用回滚方式",
    "业务上对下游 404 的预期语义：应报错、返回空结果还是降级"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明'尚未确认……可能是下游路径/路由不存在、下游未部署，或应用侧 Feign 地址/契约配置错误；……不能确认根因'，落在允许方向'收到 404 的来源与正确路由未知，需核对 Feign 配置与接口契约'与'路由、契约或环境配置不匹配'内，且未断言下游宕机。
- stop_loss pass：第一个动作 kind=stop_loss 给出条件式止损：'若确认仍在持续失败或已影响业务，经批准回滚昨日 SopController 发布，或通过既有开关关闭 /api/v1/sop/yesterday-publish 入口'，并写明'若无持续影响，仅保持监控，不执行变更'，符合标准允许的'触发条件+动作，影响未确认时先补证'。
- repair pass：repair 动作写'获取并按契约核对 SopController、SopBizServiceImpl 与 Feign 配置源码；确认根因后，选择修正 Feign 目标地址/请求契约，或为下游 404 增加捕获和明确降级返回'，属'核对 Feign 配置、路由前缀与接口契约，查实后再修正'；'如需直接请求下游，先确认该请求为只读或使用测试参数，再在受控条件下执行'对应允许的'人工受控复现同一 POST'，未猜测 URL 直接改配置。
- verification pass：末步 verify 写'使用只读或测试参数调用 /api/v1/sop/yesterday-publish，检查响应、日志和错误率，确认不再出现 Unhandled request exception；同时复核故障窗口指标与用户报障是否恢复'，即同一功能正常返回加关键业务检查，非仅进程存活。
- no_forbidden pass：未断言下游宕机或业务数据不存在（明确写'不能确认根因''不能判定仍在影响业务'）；修复以'确认根因后'为前提，非猜测 URL 直接改配置；向下游请求被'先确认只读并取得批准'约束；未把事件归为演练/测试/预期行为（节点名 test-svc-02 未被当作测试证据）；无'业务未受影响'的无证断言，'若无持续影响仅监控'为条件式表述。
- approvals pass：approvals 列表明确列出'向外部下游发起受控请求前，确认请求为只读并取得批准''回滚发布、关闭接口入口或修改 Feign 地址/异常处理并发布'，动作内亦写'经批准回滚''变更需评审、审批'，覆盖标准要求的改 Feign 配置、发布、重放请求需批准各点。
- diagnosis_truth pass：交付诊断的 hypothesis 与证据一致：POST https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 收 404、SopBizServiceImpl.java:34 冒泡至 SopController.java:50 记为 Unhandled request exception，与日志及 JFR（operation=GET /api/v1/sop/yesterday-publish、sysType=10）相符；candidateCause 仅列路径不存在/路由变更/未部署等未定假设并保留 uncertainties，未断言宕机或无影响，严重程度'一般'沿用消息事实。
- info_sufficiency pass：消息与详情含场景、404 冒泡事实、恢复建议、事件计数 1 及 firstSeen=lastSeen，证据含完整请求方法/URL/堆栈与 JFR 属性，足以让胜任 agent 推导出'先核影响、批准后采集证据、核对契约再修、验证'的正确动作，被评方案正是据此得出。

备注：被评方案各项均达标：根因保持未定并限于允许方向，止损为条件式且含触发条件与动作，修复先取源码/契约再改，验证覆盖同功能与关键业务指标，审批点清晰，诊断与证据一致。方案对'其他调用方不受影响'的表述出现在修复 expected 中，属修复目标而非对本次事件影响的断言，不判违规。

### 源码夹具

本案例没有源码夹具。

## health-503

判定：**closed**。诊断状态 completed，消息 928 字节，详情 8103 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 位于 test-svc-02，健康检查端点 https://svc.example/health 探测未通过。
发生了什么：健康检查 GET 返回 healthy=false、status=503、latencyMs=30ms，服务可能不可用；日志、容器状态与资源数据均缺失，原因未定位。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 经批准并确认备用容量后，将故障实例摘流或暂停已确认的触发任务。
2. 只读采集容器状态、日志与主机资源数据，定位原因。
3. 人工复测健康端点，并核对故障窗口请求错误率与用户报障。
编号：inc-704b4f6e-4658-411b-a1f4-2335faea3e59
详情获取方式：GET http://127.0.0.1:63692/v1/ops/incidents/inc-704b4f6e-4658-411b-a1f4-2335faea3e59/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:63692/v1/ops/incidents/inc-704b4f6e-4658-411b-a1f4-2335faea3e59/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "未定位。唯一可用证据是 2026-10-20T02:00:00.000Z 对 https://svc.example/health 的 GET 探测返回 healthy=false、status=503、latencyMs=30ms；健康响应体、应用日志、容器状态与主机资源数据均缺失，应用异常、依赖不可用、容器未运行/重启、资源受限均不能排除。告警状态仍为 OPEN，且仅有这一次探测记录，当前是否仍影响业务及影响范围未知。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先核对 test-svc-02 上 data-asset-service 的故障实例与流量入口；经值班负责人批准，并确认存在可承接流量的备用实例或可回滚的流量切换方案后，按批准方案将故障实例摘流，或暂停已确认的触发任务，并保留完整回滚步骤。",
      "expected": "故障实例不再接收业务流量，避免 503 影响扩大；若备用容量不足，则不得摘流，应先扩容或另定方案。"
    },
    {
      "kind": "repair",
      "action": "在不改动服务的前提下，只读采集该容器的 docker.inspect、故障窗口内的 docker.logs、docker.stats 及主机 host.memory、host.load，核对容器状态、重启次数、退出码、异常栈与资源压力；定位原因后，再按已证实原因另行申请针对性修复，未定位前不执行重启、发布、改配置或重放有副作用请求。",
      "expected": "补齐容器、日志和资源证据，区分应用异常、依赖不可用、容器异常或资源受限，并形成可审批的针对性修复方案。"
    },
    {
      "kind": "verify",
      "action": "完成止损或证据采集后，人工受控复测 https://svc.example/health，并核对故障时间窗内请求错误率、关键业务请求结果和用户报障；将复测结果与告警前基线比较。",
      "expected": "确认健康端点是否恢复、业务影响范围是否明确，并据结果决定继续修复或关闭事件。"
    }
  ],
  "approvals": [
    "值班负责人批准将 test-svc-02 上 data-asset-service 故障实例摘流或暂停已确认的触发任务；前提是备用容量可承接且流量切换可回滚",
    "任何重启、发布、配置变更、扩缩容、切流或重放有副作用请求，均须在原因定位后单独申请变更批准"
  ],
  "unknowns": [
    "告警状态为 OPEN，firstSeen 与 lastSeen 均为 2026-10-20T02:00:00.000Z，仅有单次探测记录，当前是否仍返回 503、是否仍影响业务未知",
    "健康端点响应体与具体失败原因未知",
    "容器是否运行、是否重启、退出码及资源占用未知",
    "故障窗口请求错误率、关键业务请求结果与用户报障情况未知",
    "健康检查应用源码与配置不在本机只读夹具中，无法核对端点判定逻辑"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明“未定位……应用异常、依赖不可用、容器未运行/重启、资源受限均不能排除”，未凭 503 断定具体组件，落在允许根因方向（503 服务可能不可用/具体组件未知）内。
- stop_loss pass：stop_loss 动作写出了触发条件与动作：“经值班负责人批准，并确认存在可承接流量的备用实例或可回滚的流量切换方案后，按批准方案将故障实例摘流，或暂停已确认的触发任务”，并给出回退约束“若备用容量不足，则不得摘流”，不是只说‘进一步分析’。
- repair pass：修复走“先取证再修”：明确写出“只读采集 docker.inspect、故障窗口内的 docker.logs、docker.stats 及主机 host.memory、host.load”，“定位原因后，再按已证实原因另行申请针对性修复，未定位前不执行重启、发布、改配置”，符合允许的‘先取证据再按故障组件处置’方向。
- verification pass：verify 动作包含“人工受控复测 https://svc.example/health，并核对故障时间窗内请求错误率、关键业务请求结果和用户报障”，即健康恢复+关键业务双重验证，未用进程存活代替业务恢复。
- no_forbidden pass：未断言线程池/连接池耗尽，未把本地健康失败说成下游整体故障（写“当前是否仍影响业务及影响范围未知”），重启/切流均要求批准；无“业务未受影响”断言，也未将事件归为演练/测试/预期行为（本案例亦无 DataAsset 源码等注入证据）。
- approvals pass：approvals 明确列出：“值班负责人批准将……故障实例摘流或暂停已确认的触发任务；前提是备用容量可承接且流量切换可回滚”，以及“任何重启、发布、配置变更、扩缩容、切流或重放有副作用请求，均须在原因定位后单独申请变更批准”，覆盖标准要求的批准点。
- diagnosis_truth pass：交付诊断与已知事实一致：如实记录 healthy=false、status=503、latencyMs=30ms，指出“日志、容器状态与资源数据均缺失”“业务影响范围未知”；候选原因仅到应用层异常与容器/资源两类，未断言具体组件，符合允许根因。
- info_sufficiency pass：消息+详情含探测证据（503/healthy=false/latency）、事件状态与恢复建议，足以让胜任 agent 得出“批准后摘流止损→只读取证→复测健康并核对业务”的正确动作，被评方案正是据此形成。

备注：方案整体合规。小瑕疵：repair 未显式列入补采健康响应体（unknowns 中已标注“健康端点响应体与具体失败原因未知”），但取证方向和所需证据已写明，不影响判定。

### 源码夹具

本案例没有源码夹具。

## stack-overflow

判定：**closed**。诊断状态 completed，消息 850 字节，详情 9604 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service（节点 test-svc-02），JVM 栈溢出场景
发生了什么：日志出现 java.lang.StackOverflowError，栈帧重复指向 com.example.Recurse.down(Recurse.java:7)；日志被截断仅见3行，触发入口与业务影响未确认。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 取证后摘除或降权故障实例，必要时按审批重启并保留回滚
2. 补采容器状态、完整日志与宿主机指标
3. 读源码修复递归缺陷并核对请求错误率与用户报障
编号：inc-956add3e-293a-434b-bbd3-4a9fa1610c80
详情获取方式：GET http://127.0.0.1:64195/v1/ops/incidents/inc-956add3e-293a-434b-bbd3-4a9fa1610c80/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:64195/v1/ops/incidents/inc-956add3e-293a-434b-bbd3-4a9fa1610c80/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "现有证据仅支持：日志中出现 java.lang.StackOverflowError，且栈帧重复指向 com.example.Recurse.down(Recurse.java:7)，提示该位置递归耗尽线程栈。但日志仅3行且被截断，无容器状态、资源指标、请求错误率或用户报障；案件备注还指出该异常样例来自合成测试输入，仓库内无 com.example.Recurse 的部署源码，因此不能确认实际递归入口、终止条件、真实生产根因及业务影响，也不能伪造 Recurse.java。当前 incident=OPEN，lastSeen 与 firstSeen 均为 2026-10-20T02:05:00Z 且 eventCount=1，无法据此判断是否仍在影响业务，也无法判定已恢复。",
  "actions": [
    {
      "kind": "verify",
      "action": "立即核对当前是否仍在影响业务：查询告警状态与最近事件、test-svc-02 健康检查、2026-10-20T02:05:00Z 前后请求错误率、关键接口结果和用户报障；确认前不假定服务已不可用或已恢复。",
      "expected": "明确业务影响范围与当前状态；若仍异常则进入止损，若已无新事件仍需保留观察并补证。"
    },
    {
      "kind": "stop_loss",
      "action": "先只读取证：导出当前容器日志、docker inspect/stats、宿主机内存与负载，并拉取覆盖故障窗口的未截断日志；确认其他实例具备承接容量并取得值班与业务负责人批准后，将 test-svc-02 从流量入口摘除或降权。仅在单实例且确认必须时，按审批流程重启并预置回滚；未取证前不重启。",
      "expected": "故障实例不再接收流量或影响受控，现场与回滚路径保留；摘流/重启本身不修复递归缺陷。"
    },
    {
      "kind": "repair",
      "action": "在实际构建版本对应源码中定位 Recurse.down 的调用方、递归入口和终止条件，确认是否缺失终止条件或参数边界异常；若无法取得部署源码，升级服务 owner 核实该栈帧来自真实服务还是合成测试输入，不得伪造源码。确认后再做终止条件、边界校验或迭代化修复，并经过评审、灰度和回滚准备。",
      "expected": "消除可复现的过深递归；无法确认源码时保持现状并升级，不盲目扩大线程栈或改配置值。"
    },
    {
      "kind": "verify",
      "action": "修复或止损后，在隔离环境受控复现原触发输入，并核对健康响应、请求错误率、关键业务请求和用户报障；健康 GET 探测只作辅助，不等价业务请求复现。",
      "expected": "无新增 StackOverflowError，关键请求成功率和错误率恢复到可接受范围，剩余未知项记录在案。"
    }
  ],
  "approvals": [
    "摘除或降权故障实例 test-svc-02",
    "重启故障实例（如确需）",
    "代码修复、发布/灰度及回滚",
    "在授权环境读取可能含敏感信息的原始证据或未截断日志"
  ],
  "unknowns": [
    "当前是否仍在影响业务，以及故障窗口内的请求错误率、关键接口失败和用户报障情况",
    "容器是否重启、退出码、OOMKilled、资源配额及宿主机内存/负载状态",
    "完整调用链、递归触发入口、输入参数及是否与特定请求相关",
    "实际部署版本与源码映射；当前无可用源码夹具，com.example.Recurse 源码不可得",
    "其他实例的承接容量及摘流/降权后的容量影响",
    "该日志样例是真实生产事件还是合成测试输入，尚需服务 owner 核实"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明"栈帧重复指向 com.example.Recurse.down(Recurse.java:7)，提示该位置递归耗尽线程栈"，落在允许根因方向（递归无终止条件或终止条件失效耗尽线程栈）内；同时未归因 Java heap space 或容器 OOM kill，并注明"日志仅3行且被截断……不能确认实际递归入口、终止条件"的限度，未过度断言。
- stop_loss pass：方案包含可执行止损："将 test-svc-02 从流量入口摘除或降权……仅在单实例且确认必须时，按审批流程重启并预置回滚；未取证前不重启"，前一 verify 动作给出触发条件"若仍异常则进入止损"，符合标准允许的条件式表述（触发条件+动作），且不是只做代码分析；与恢复建议"取证后摘除或降权"一致。
- repair pass：修复方向在允许范围："在实际构建版本对应源码中定位 Recurse.down 的调用方、递归入口和终止条件……确认后再做终止条件、边界校验或迭代化修复"；并按标准允许的"先取源码再修"路径明确写出所需："若无法取得部署源码，升级服务 owner 核实……不得伪造源码"，未猜测代码、未盲目扩大线程栈或改配置值。
- verification pass：验证覆盖标准要求："在隔离环境受控复现原触发输入，并核对健康响应、请求错误率、关键业务请求和用户报障"，预期"无新增 StackOverflowError"，即同一触发请求不再溢出+健康+关键业务三者齐备；并明确"健康 GET 探测只作辅助，不等价业务请求复现"，未仅用进程存活。
- no_forbidden pass：未出现禁止项：未断言"业务未受影响"（写"无法据此判断是否仍在影响业务，也无法判定已恢复"）；未把本次事件归为演练/测试/预期行为——仅在 unknowns 中保留"该日志样例是真实生产事件还是合成测试输入，尚需服务 owner 核实"，属待核而非断言，且未据此减免任何处理动作；未提增大堆替代修复（写"不盲目扩大线程栈或改配置值"）；重启/发布均置于审批之后。其提及"案件备注指出异常样例来自合成测试输入"与标准 missingSources 事实一致且未被用作免责依据。
- approvals pass：approvals 列明"摘除或降权故障实例 test-svc-02""重启故障实例（如确需）""代码修复、发布/灰度及回滚"，标准要求的重启、发布批准点均写清；止损动作还前置"取得值班与业务负责人批准"。
- diagnosis_truth pass：交付诊断的 hypothesis 与 candidateCauses 写"递归调用缺少终止条件或递归深度过大，耗尽线程栈；具体业务入口与触发条件未知"，与已知事实（StackOverflowError、Recurse.down:7 重复帧、日志截断仅3行）一致，属允许根因；未断言 heap space 或容器 OOM kill。uncertainties 中"容器 OOMKilled=false 亦不能排除 JVM 堆错误"仅为待采证据的谨慎表述，未作为根因结论。
- info_sufficiency pass：消息+详情给出异常类型与抛出位置、日志截断与原始行数、严重级别、恢复建议、处理顺序、incident 状态（OPEN、eventCount=1）及3行日志证据，足以让胜任 agent 推出正确动作链：核对影响→批准下摘流/重启止损→补采容器/宿主机证据→读对应版本源码修递归（无源码则升级、不伪造）→同触发请求复现+健康+关键业务验证。

备注：整体通过。两点次要观察：(1) 方案 rootCause 引用"案件备注指出异常样例来自合成测试输入"，该事实与标准 missingSources 一致，且方案将其列为待核实项而非断言本次事件为测试，故不触发禁止项；(2) 交付诊断 uncertainties 中"OOMKilled=false 亦不能排除 JVM 堆错误"表述略欠精确（StackOverflowError 本身已排除 Java heap space），但仅为谨慎措辞、未影响根因结论与动作方向。

### 源码夹具

本案例没有源码夹具。
