# 值班消息闭环评测

真实模型：诊断 ark/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。

闭环 7/7，部分闭环 0，未闭环 0。已回报 token 320182，预算 400000。总耗时 1114 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| dataasset-197 | completed | 1070 | 19638 | 3 | closed | 无 | 无 | 42534 | 177512 |
| jvm-heap-oom | completed | 965 | 22232 | 3 | closed | 无 | 无 | 85893 | 288066 |
| cpu-quota-burst | completed | 1072 | 20598 | 3 | closed | 无 | 无 | 77767 | 228746 |
| tag-group-502 | completed | 915 | 9449 | 2 | closed | 无 | 无 | 28361 | 105639 |
| sop-404 | completed | 948 | 9894 | 2 | closed | 无 | 无 | 28291 | 84676 |
| health-503 | completed（降级）（自动检查未过） | 856 | 6518 | 2 | closed | 无 | 无 | 24670 | 89356 |
| stack-overflow | completed | 786 | 8126 | 2 | closed | 无 | 无 | 32666 | 129149 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。

本批没有未闭环案例，所有卡点列为空。

## dataasset-197

判定：**closed**。诊断状态 completed，消息 1070 字节，详情 19638 字节。

### 企微消息原文

```text
### 诊断更新
场景：rdl-dataasset-6dfb8e88 数据资产服务，/auth/lab/server-fault 接口
发生了什么：GET /auth/lab/server-fault 在 LabFaultController.java:25 抛出 IllegalStateException，被全局异常处理器拦截；容器运行中、未重启、无 OOMKill 迹象。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 修补前先补证：读 LabFaultController.java:25 源码并统计该接口请求量与错误率，确认调用来源与影响面。
2. 修复尚未确定：依据源码判断是硬编码异常还是入参触发，再决定移除接口、加访问控制或修正逻辑，发布需人工审批并准备回滚。
3. 补证后复核关键业务接口错误率与用户报障，确认影响范围。
编号：inc-7ad7f023-0540-401c-a427-2dcb10ef9162
详情获取方式：GET http://127.0.0.1:63550/v1/ops/incidents/inc-7ad7f023-0540-401c-a427-2dcb10ef9162/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:63550/v1/ops/incidents/inc-7ad7f023-0540-401c-a427-2dcb10ef9162/brief?format=markdown
- 第 2 轮 read_source 成功：apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java

### 处理 agent 结论

```json
{
  "rootCause": "源码已确认：LabFaultController 第23-26行的 GET /auth/lab/server-fault 映射到 serverFault()，第25行无条件 throw new IllegalStateException(\"Real DataAsset lab fault injection\")，与日志中的异常消息、类名和行号完全一致，属于硬编码抛错，而非入参或运行时状态触发。该类受 @Profile(\"real-dataasset-lab\") 与 lab.fault.enabled=true（matchIfMissing=false）双重条件约束，且来自 lab-fault-fixture.jar；因此本次异常的近因是该实验室故障端点在当前运行的容器中被启用并可被 GET 调用。异常被 GlobalExceptionHandler 拦截，容器 running、RestartCount=0、OOMKilled=false，docker.stats 显示 usage=689377280、limit=1610612736，没有资源耗尽迹象。但“lab 故障注入”这一文本本身不能证明本次是演练或预期行为；当前事故仍为 OPEN，lastSeen 与 firstSeen 相同（2026-10-14T03:40:12.880Z），eventCount=2；接口请求量、错误率、是否通过网关对外暴露以及关键业务是否受影响均未取得，因此不能判定“未影响业务”，只能判定“尚无服务不可用或关键业务受影响的确认事实”。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先核实 /auth/lab/* 是否经网关、WAF 或公网入口对外可达，以及故障窗口内该路径的请求量与状态码分布；如果存在外部可达路径，提交变更单，在网关或 WAF 上拒绝 /auth/lab/* 的外部访问（或仅允许受控来源），无需改动应用代码。",
      "expected": "阻断后外部匿名调用无法再触达该 lab 端点，接口错误不再新增，且不影响正常业务路由。"
    },
    {
      "kind": "repair",
      "action": "依据核实结果决定修复方式：若该镜像被部署到非实验室环境，应在生产构建中移除 lab-fault-fixture.jar，或确保不激活 real-dataasset-lab profile、lab.fault.enabled 不为 true；若该环境确为实验室且需保留端点，则改为网关访问控制并限制来源。任何镜像重建、配置修改或发布都必须先取得人工审批，保留上一版本镜像与配置并准备回滚。",
      "expected": "生产流量路径上不再暴露无条件抛错的 lab 端点，或该端点仅对受控来源可达；异常不再随匿名 GET 请求产生。"
    },
    {
      "kind": "verify",
      "action": "补证并验证：统计 2026-10-14T03:40:12 前后窗口内 /auth/lab/server-fault 的请求量、状态码与调用来源，复核关键业务接口错误率及用户报障；变更后再次请求该路径确认返回 403/404 或被网关拒绝，并抽查关键业务接口健康响应与容器 RestartCount、OOMKilled、docker.stats 内存变化。",
      "expected": "确认影响范围为孤立/受控请求或明确存在外部调用；变更后该路径不再产生 IllegalStateException，关键业务接口错误率无异常上升，容器无重启与内存异常。"
    }
  ],
  "approvals": [
    "网关/WAF 增加或修改 /auth/lab/* 访问控制规则需审批",
    "生产镜像重建、移除 lab-fault-fixture.jar 或修改 profile/lab.fault.enabled 配置并发布需审批，且需准备回滚版本",
    "如需临时下线或重启容器需单独审批，本次不建议以重启作为止损"
  ],
  "unknowns": [
    "该接口在故障窗口内的请求量、错误率、调用来源及是否有外部匿名访问，均未取得",
    "当前运行镜像是否与 lab-fault-fixture.jar 源码版本一致，以及生产环境为何激活 real-dataasset-lab profile / lab.fault.enabled=true",
    "关键业务接口错误率与用户报障尚未核实，不能确认业务未受影响",
    "eventCount=2 对应的两次事件时间分布与完整日志窗口未取得（docker.logs 为 197 行截断投影）",
    "JVM 堆状态未单独获取，容器内存不能替代堆指标",
    "容器 Health 为空，缺少健康检查结果"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写道：'第25行无条件 throw new IllegalStateException("Real DataAsset lab fault injection")……属于硬编码抛错，而非入参或运行时状态触发'，'本次异常的近因是该实验室故障端点在当前运行的容器中被启用并可被 GET 调用'，正落在允许根因'请求命中演练/故障注入端点，异常是显式注入，不是业务代码缺陷'与'注入端点被暴露或被真实流量调用'之内；且方案明确'"lab 故障注入"这一文本本身不能证明本次是演练或预期行为'，未越界把事件归为演练。
- stop_loss pass：首个动作 kind=stop_loss：'先核实 /auth/lab/* 是否经网关、WAF 或公网入口对外可达，以及故障窗口内该路径的请求量与状态码分布；如果存在外部可达路径，提交变更单，在网关或 WAF 上拒绝 /auth/lab/* 的外部访问（或仅允许受控来源）'——既包含'先确认该路径是否仍被调用'的核实，也写出了触发条件（存在外部可达路径）与具体动作（网关/WAF 拒绝外部访问），且 approvals 中注明该规则变更需审批，符合'经批准限制/下线该端点'，并非只说'进一步分析'。
- repair pass：修复动作为'若该镜像被部署到非实验室环境，应在生产构建中移除 lab-fault-fixture.jar，或确保不激活 real-dataasset-lab profile、lab.fault.enabled 不为 true；若该环境确为实验室且需保留端点，则改为网关访问控制并限制来源'，即'先取源码确认 lab-only 与 profile/开关，再决定限制或移除'，在允许修复范围内；工具记录显示第2轮已 read_source 读取 LabFaultController.java，unknowns 中也列明'当前运行镜像是否与 lab-fault-fixture.jar 源码版本一致'待核。
- verification pass：verify 动作写明'变更后再次请求该路径确认返回 403/404 或被网关拒绝，并抽查关键业务接口健康响应'，expected 为'变更后该路径不再产生 IllegalStateException，关键业务接口错误率无异常上升'，同时覆盖'同一路径不再产生注入异常'与'关键业务接口正常'，并附容器 RestartCount/OOMKilled/docker.stats 作为附加观察，不是只用进程存活验证。
- no_forbidden pass：方案全文未提 RocketMQ，未断言数据库/库存/外部依赖故障；所有变更性操作均挂在审批下（'任何镜像重建、配置修改或发布都必须先取得人工审批'‘如需临时下线或重启容器需单独审批，本次不建议以重启作为止损’）；明确写'不能判定"未影响业务"，只能判定"尚无服务不可用或关键业务受影响的确认事实"'，并写'"lab 故障注入"这一文本本身不能证明本次是演练或预期行为'，避免了无证据断言；将端点定性为故障注入端点有源码依据（源码注明 Explicit lab-only HTTP faults、消息 Real DataAsset lab fault injection），属标准认可的 DataAsset 源码证据，不构成'断言本次是演练'。
- approvals pass：方案单列 approvals：'网关/WAF 增加或修改 /auth/lab/* 访问控制规则需审批'、'生产镜像重建、移除 lab-fault-fixture.jar 或修改 profile/lab.fault.enabled 配置并发布需审批，且需准备回滚版本'、'如需临时下线或重启容器需单独审批'，覆盖了下线/限制端点、修改 profile/配置、发布、重启四类需批准点，并在 repair 中写明'保留上一版本镜像与配置并准备回滚'。
- diagnosis_truth pass：交付诊断与已知事实一致：hypothesis 与 observations 准确复述 IllegalStateException 于 LabFaultController.java:25、GET /auth/lab/server-fault、GlobalExceptionHandler 拦截、容器 running/RestartCount=0/OOMKilled=false，并注明'日志被截断投影（原始197行，仅保留部分片段）'对应'原始日志 197 行'；candidateCauses 写'serverFault 方法抛出 IllegalStateException（lab-fault 模块代码）……是否预期暴露及触发来源未知'，落在允许根因方向，未断言资源、演练或'业务未受影响'，severity 理由为'尚无服务不可用或关键业务受影响的确认事实'而非断言无影响。
- info_sufficiency pass：消息与详情足以支撑正确动作：brief 给出'读 LabFaultController.java:25 源码并统计该接口请求量与错误率''发布需人工审批并准备回滚'等指引，详情含 JFR 栈、docker.logs（'Real DataAsset lab fault injection'、lab-fault-fixture.jar）、docker.inspect/stats 与完整诊断动作，源码夹具可读取（被评 agent 第2轮 read_source 成功），胜任 agent 可据此得出'读源码确认注入端点与开关→核实暴露面与流量→经审批限制/移除→复验同路径与关键业务'的正确动作链。

备注：八项全部通过。被评 agent 先读源码再下根因，把'日志注入字样'与'源码写明注入'区分开，既采纳了有证据的注入定性，又未把本次事件断言为演练或预期行为；止损为条件式表述但触发条件与动作齐备，且全部变更性操作挂在审批与回滚之下，与标准一致。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java（演练注入控制器源码（与真实 lab 构建一致）），sha256 e8d241669facac9de1902cf33f8eabdd61ac299733389f53f08c21a5205f379c

## jvm-heap-oom

判定：**closed**。诊断状态 completed，消息 965 字节，详情 22232 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service-本地演练-20261004-053012-36c038，本地容器内JDK17应用
发生了什么：JVM抛出java.lang.OutOfMemoryError: Java heap space，栈顶为Drill.exhaustHeap；容器仍运行且OOMKilled=false，宿主内存使用9.37%，业务影响未确认。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 人工批准后隔离故障容器流量或重启止损，保留日志与堆转储
2. 采集JVM堆与GC指标及故障窗口内存曲线，区分堆上限不足与瞬时大分配
3. 核对故障窗口请求错误率与用户报障，确认业务影响；修复尚未确定，需先取源码与堆分析定位
编号：inc-ad79b067-a3ae-41fc-bb28-64ef16ead246
详情获取方式：GET http://127.0.0.1:50196/v1/ops/incidents/inc-ad79b067-a3ae-41fc-bb28-64ef16ead246/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:50196/v1/ops/incidents/inc-ad79b067-a3ae-41fc-bb28-64ef16ead246/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "已确认的直接原因是：Drill.exhaustHeap 在循环中每次分配 1 MiB 的 byte 数组并持续持有，最终耗尽 Java 堆，JFR 在 05:30:25 记录到 java.lang.OutOfMemoryError: Java heap space，栈顶为 Drill.exhaustHeap(Drill.java:285)。源码中该路径只由 POST /heap 触发，属于内建的堆压力演练逻辑，不是订单处理路径；日志随后出现“Allocation work completed; retained memory released”，容器仍为 running 且 OOMKilled=false，说明这次 OOM 被捕获并释放了保留内存，但不能据此认定业务未受影响。调用 /heap 的来源、该端点是否暴露到非本地网络、实际 -Xmx 及业务影响仍未确认。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先确认当前是否仍在影响业务：检查容器 /health 是否返回 200 且 healthy=true，核对 05:30:25 前后网关或访问日志错误率、关键业务结果和用户报障，并采集当前 docker stats 与 jcmd GC.heap_info 观察堆是否再次上涨。注意源码中 /health 的 healthy 标志不能单独证明业务成功，/order 是固定返回 500 的演练失败路径，不能当作业务恢复验证。",
      "expected": "明确服务当前是否仍不可用及影响范围；若健康检查失败、业务请求持续报错或堆再次上涨，按真实故障升级处置，不因容器仍在运行而判定无影响。"
    },
    {
      "kind": "stop_loss",
      "action": "在人工批准并确认回滚与备用容量后，阻断 POST /heap 控制端点（网络策略、仅绑定 127.0.0.1 或从运行镜像移除路由），并对故障容器隔离流量；若业务已确认不可用且隔离不足，再批准重启容器。重启前保留 docker logs、JFR、当前启动参数和可用堆转储，避免覆盖现场。",
      "expected": "阻止通过 /heap 再次触发堆耗尽，降低复发和业务影响；重启仅用于恢复，不修复可重入的 /heap 路径则仍可能复发。"
    },
    {
      "kind": "repair",
      "action": "按源码修复控制面：为 /heap 增加默认关闭且需显式启用的开关、鉴权，并限制为本地绑定；生产镜像不应暴露该演练端点。若后续 GC.heap_info、class_histogram 或堆转储证明是堆上限不足，再评估调整 -Xmx；当前 OOM 发生在显式 1 MiB 分配循环，证据不支持直接调大堆。代码修改、发布、网络策略变更和堆参数调整均需评审与批准。",
      "expected": "控制端点不可被误调用或外部调用，堆耗尽风险被消除；若确认堆上限不足，调整后有明确依据而非猜测参数。"
    },
    {
      "kind": "verify",
      "action": "处置后验证：确认 /health 返回 200，观察一个以上业务窗口的请求错误率、延迟和用户报障恢复正常；确认 OOM/JFR 事件不再新增，docker stats 与 jcmd GC.heap_info 无持续上涨，并验证 /heap 已被拒绝、隔离或不可达。记录修复内容、验证时间、剩余未知项和回滚结果。",
      "expected": "健康响应和关键业务指标均稳定，未再出现 OOM 堆栈，控制端点不可触发；若缺少业务监控数据，则明确记录影响仍未确认，不能宣称已完全恢复。"
    }
  ],
  "approvals": [
    "隔离故障容器流量或重启容器：需人工批准，前提是已确认业务受影响或服务不可用，并先保留日志、JFR、启动参数与可用堆转储，确认备用容量和回滚方案。",
    "阻断或移除 /heap 控制端点、修改绑定地址或网络策略、发布代码：需变更审批、测试和回滚方案。",
    "调整 -Xmx/堆参数或增加 HeapDumpOnOutOfMemoryError 并重启：需人工批准；当前证据不足，应先完成堆与 GC 采样。",
    "采集堆转储或读取可能含敏感信息的原始证据：需在授权环境和批准范围内进行，并评估 STW 与磁盘占用。"
  ],
  "unknowns": [
    "故障窗口请求错误率、关键业务接口结果和用户报障未提供；/health 的 healthy 标志不能证明业务成功，业务影响仍未确认。",
    "谁调用了 POST /heap、该控制端点是否暴露到非本地网络未知；docker.logs 为截断视图且未记录控制端点调用来源。",
    "实际 -Xmx/maxMemory、GC 行为、故障时堆峰值和对象分布未知；05:31:25 的 docker.stats 显示 206823424/536870912，属事后采样，不代表故障峰值。",
    "OOM 被捕获并释放内存后是否已完全恢复、是否还有后续复发未知；当前事件计数为 1。",
    "堆转储是否存在及是否可用未知，因而尚不能完成分配路径与对象分布的堆分析。"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写明'Drill.exhaustHeap 在循环中每次分配 1 MiB 的 byte 数组并持续持有，最终耗尽 Java 堆'，与允许根因'应用内持续分配对象导致 Java heap space（Drill.exhaustHeap / com.example.MemoryFailure）'一致；同时补充'这次 OOM 被捕获并释放了保留内存，但不能据此认定业务未受影响'，覆盖允许根因第二条（retained memory released 但业务恢复未知），未滑向容器 OOM kill 或宿主内存耗尽。
- stop_loss pass：止损为条件式但触发与动作齐全：'若健康检查失败、业务请求持续报错或堆再次上涨，按真实故障升级处置'；第二个 stop_loss 动作写明'阻断 POST /heap 控制端点（网络策略、仅绑定 127.0.0.1 或从运行镜像移除路由），并对故障容器隔离流量；若业务已确认不可用且隔离不足，再批准重启容器。重启前保留 docker logs、JFR、当前启动参数和可用堆转储'，即停止触发源+隔离+带前提与批准的重启，符合标准'先停止触发……重启必须说明前提与批准'。
- repair pass：修复方向在允许范围：按源码修控制面（'/heap 增加默认关闭且需显式启用的开关、鉴权，并限制为本地绑定'）即停止演练触发方向的修复；堆调整明确设了证据门槛：'若后续 GC.heap_info、class_histogram 或堆转储证明是堆上限不足，再评估调整 -Xmx；当前……证据不支持直接调大堆'。agent 第2轮已 read_source 取得源码再定修复，符合'先取源码/证据再修'并写明所需证据。
- verification pass：验证动作包含健康与关键业务及 JVM 堆指标：'确认 /health 返回 200，观察一个以上业务窗口的请求错误率、延迟和用户报障恢复正常……docker stats 与 jcmd GC.heap_info 无持续上涨'；未把 docker.stats 当 JVM 堆（JVM 堆用 jcmd GC.heap_info，并在 unknowns 指出 docker.stats '属事后采样，不代表故障峰值'），还写明'若缺少业务监控数据……不能宣称已完全恢复'，满足'健康+关键业务+JVM 堆指标'的完整要求。
- no_forbidden pass：无禁止项：未断言 OOM kill（写'OOMKilled=false'）；未声称已知 Xmx（'实际 -Xmx……仍未确认'）；未断言业务已恢复（'是否已完全恢复……未知'且'不能据此认定业务未受影响'）；拒绝无证据调堆（'证据不支持直接调大堆'）。关于演练：方案仅描述代码路径'该路径只由 POST /heap 触发，属于内建的堆压力演练逻辑'（有 Drill.java /heap 端点源码为据），同时保留'调用 /heap 的来源、该端点是否暴露到非本地网络……仍未确认'，并在止损中写'按真实故障升级处置，不因容器仍在运行而判定无影响'——未把本次事件归为演练/预期行为。
- approvals pass：approvals 列表逐项写清：'隔离故障容器流量或重启容器：需人工批准……确认备用容量和回滚方案'；'阻断或移除 /heap 控制端点、修改绑定地址或网络策略、发布代码：需变更审批、测试和回滚方案'；'调整 -Xmx/堆参数或增加 HeapDumpOnOutOfMemoryError 并重启：需人工批准；当前证据不足，应先完成堆与 GC 采样'；并以'记录当前启动参数与JVM堆配置作为回滚依据'落实回滚方式，覆盖重启、发布、调堆三个必批点。
- diagnosis_truth pass：交付诊断与已知事实一致：假设为'JVM 于 05:30:25 抛出 java.lang.OutOfMemoryError: Java heap space，栈顶为 Drill.exhaustHeap；容器 OOMKilled=false……属应用堆耗尽'，正确认定 JVM 堆 OOM 而非容器 OOM kill；candidateCause'JVM堆内存在Drill.exhaustHeap路径上被耗尽'落在允许根因内；uncertainties 承认'JVM实际堆上限……未知''业务影响未确认'，无 OOM kill 断言、无业务恢复断言、无把事件归为演练的表述。
- info_sufficiency pass：消息与详情已含关键信息：JFR 事件给出异常与栈（Drill.exhaustHeap Drill.java:285）、docker.inspect 给出 OOMKilled=false 与容器限制、日志含'Allocation work completed; retained memory released'、docker.stats 为事后采样，且源码可通过 read_source 获取（agent 第2轮成功读取 Drill.java）。胜任的 agent 可据此得出正确动作（核实业务影响、阻断触发、采集 JVM 堆证据、批准后重启），标准 missingSources 为 null，信息充分。

备注：唯一需斟酌之处是方案中'属于内建的堆压力演练逻辑'的措辞：它是对源码 /heap 路径的定性（有源码依据），且方案随即保留触发来源未知、并要求按真实故障升级处置，未把本次事件归为演练/预期行为，故 no_forbidden 判通过。交付诊断未显式引用'retained memory released'日志，但与其不矛盾且业务恢复未知已表达，不影响 diagnosis_truth。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## cpu-quota-burst

判定：**closed**。诊断状态 completed，消息 1072 字节，详情 20598 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 本地容器，容器名 order-local-drill-20261004-053526-be8ec9，JVM CPU 压力告警
发生了什么：jdk.CPULoad 记录一次 jvmUser=0.19405940175056458、machineTotal=0.2049504965543747；容器 running、OOMKilled=false、RestartCount=0，主机 load1=0.01，日志未见异常
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 核对 2026-10-04T05:35 前后请求错误率、关键接口结果与用户报障，确认业务影响
2. 修复尚未确定：先拉取完整日志与连续 docker.stats 及 throttling 数据，据此区分单点毛刺与持续压力
3. 若确认持续高压，经审批并备回滚后隔离流量、限制触发任务或扩容，并验证 CPU 与错误率回落
编号：inc-0fe8d61f-a815-4352-af67-5eb12b2e3a3e
详情获取方式：GET http://127.0.0.1:53115/v1/ops/incidents/inc-0fe8d61f-a815-4352-af67-5eb12b2e3a3e/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:53115/v1/ops/incidents/inc-0fe8d61f-a815-4352-af67-5eb12b2e3a3e/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "尚未确定，现有证据更支持 2026-10-04T05:35:40 前后出现一次短时 JVM/容器 CPU 峰值：JFR 仅 1 条 jvmUser=0.19405940175056458、jvmSystem=0；docker.stats 在 05:35:40.192 至 05:35:41.199 的 total_usage 差分约 1.93e9ns，按常见差分口径约 1.9 核，而 05:36:38 前后差分接近 0；主机 load1=0.01、容器 running、无 OOM、重启次数为 0，日志未见异常。峰值是否造成业务影响、触发来源均未确认。源码夹具显示 /cpu 控制端点可产生 1 至 30 秒、最多 4 线程的 CPU 负载，且仅当 jvmUser+jvmSystem >= CPU_THRESHOLD 时才发布 jvm.cpu_pressure；默认 0.80 时 0.194 不应发布，因此还需核对运行时 CPU_THRESHOLD 和镜像版本，不能据此判定为演练、误报或预期行为。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "暂不重启、不切流、不扩容、不改配置；维持容器运行，并立即核对 05:35 前后请求错误率、关键接口结果和用户报障，确认是否仍有业务影响。",
      "expected": "在未确认影响前避免引入变更风险，并明确业务是否受影响。"
    },
    {
      "kind": "verify",
      "action": "只读拉取该容器 05:35:27 至 05:36:40 的完整 docker logs/JFR 序列，核对 05:35:40 前后所有 jdk.CPULoad 采样、异常和触发任务；同时处理日志视图 originalLineCount=12 与诊断文本 74 的不一致。",
      "expected": "确认峰值持续时长、是否单点毛刺，以及是否有 /cpu 等触发记录。"
    },
    {
      "kind": "verify",
      "action": "连续多次采集 docker.stats（覆盖数分钟），记录 total_usage 差分、system_cpu_usage、online_cpus 和 throttling_data；并只读核对容器环境变量 CPU_THRESHOLD、CPU_SECONDS、CPU_THREADS 及镜像版本。",
      "expected": "区分持续压力与短时峰值，并解释 0.194 的采样为何达到发布阈值。"
    },
    {
      "kind": "verify",
      "action": "用 /health 和真实业务监控核对服务健康与关键接口成功率；不要用 /order 作为健康判据，源码夹具显示它会固定抛出 IllegalStateException。",
      "expected": "确认服务健康状态和真实业务影响，避免误用必然失败的接口。"
    },
    {
      "kind": "repair",
      "action": "仅当确认持续高压或业务接口失败时，经值班负责人批准并记录 NanoCpus=2000000000 等原配置及回滚方案后，隔离故障流量、限制已确认的触发任务或扩容备用实例；若发现 CPU_THRESHOLD 配置错误，按变更流程审批后修正并验证。",
      "expected": "缓解 CPU 压力或纠正告警阈值配置；若恶化则按回滚方案恢复。"
    }
  ],
  "approvals": [
    "任何重启、发布、配置变更、切流、扩容或限制触发任务均需值班负责人批准，并准备回滚。",
    "受控复现（例如调用 /cpu）会引入额外 CPU 负载，需单独批准并限定范围和时长。",
    "读取原始证据可能含敏感信息，仅在授权环境进行。"
  ],
  "unknowns": [
    "业务影响未确认：缺少 2026-10-04T05:35 前后请求错误率、关键接口结果和用户报障。",
    "05:35:40 峰值持续时长和触发来源未知；完整日志/JFR 在保留视图中缺失，且 originalLineCount 存在 12 与 74 的不一致。",
    "运行时 CPU_THRESHOLD 及镜像/源码版本未知；夹具默认 0.80 与本次 0.194 即发布告警的现象不吻合。",
    "缺少连续 throttling_data，无法确认是否发生 CPU 限速；NanoCpus=2000000000 与 CpuQuota=0 的实际调度约束需核实。",
    "是否调用过 /cpu 控制端点或其他短时任务未知；源码能力本身不能证明本次触发原因。"
  ]
}
```

### 裁判理由

- root_cause pass：方案写明“尚未确定，现有证据更支持……一次短时 JVM/容器 CPU 峰值”，并用 docker.stats 原始差分“约 1.93e9ns，按常见差分口径约 1.9 核”对上已知事实‘故障期约 1.91 核、容器配额 2 核’，同时引“主机 load1=0.01”承认整机未饱和，未断言已确认热点或整机饱和，且在 unknowns 中列出“无法确认是否发生 CPU 限速”，落在允许根因方向内。
- stop_loss pass：stop_loss 动作写明“暂不重启、不切流、不扩容、不改配置；维持容器运行，并立即核对 05:35 前后请求错误率、关键接口结果和用户报障”；repair 动作再给出条件止损：“仅当确认持续高压或业务接口失败时，经值班负责人批准……隔离故障流量、限制已确认的触发任务”，触发条件与动作齐备，且符合‘影响确认前不盲目扩容或重启’。
- repair pass：符合‘先取源码/证据再修’：先“只读拉取……完整 docker logs/JFR 序列”“连续多次采集 docker.stats……throttling_data”并核对 CPU_THRESHOLD 等运行时配置，修复仅在确认后“经值班负责人批准并记录 NanoCpus=2000000000 等原配置及回滚方案后”执行，方向为隔离流量/限制触发任务/扩容，未跳到未经证实的代码优化或直接调配额。
- verification pass：验证动作为“用 /health 和真实业务监控核对服务健康与关键接口成功率”，并明确“不要用 /order 作为健康判据”，不是仅看进程存活；同时配合连续 docker.stats 记录 total_usage 差分与 system_cpu_usage 观察 CPU 回落，根因部分已用 host load1=0.01 确认非整机饱和，覆盖健康+关键业务+机器整体负载。
- no_forbidden pass：明确写“不能据此判定为演练、误报或预期行为”和“源码能力本身不能证明本次触发原因”，未因容器名/镜像含 drill 或存在 /cpu 端点而断言本次是演练；严重度理由是“尚无……确认事实”而非断言业务未受影响；用原始 ns 差分折算核数而非把归一化 ratio 当配额利用率，还主动声明“不能直接换算为容器配额百分比”；扩容、重启均挂在批准条件之后。
- approvals pass：approvals 列明“任何重启、发布、配置变更、切流、扩容或限制触发任务均需值班负责人批准，并准备回滚”，并额外要求“受控复现（例如调用 /cpu）……需单独批准并限定范围和时长”，覆盖了标准要求的扩容、调配额（配置变更）、重启三类批准点。
- diagnosis_truth pass：诊断摘要假设“更倾向瞬时毛刺而非持续 CPU 压力”与已知事实‘故障期约 1.91 核、事后采样回落’一致（05:36:38 采样差分接近 0 可佐证），machineTotal=0.205、load1=0.01 与‘10 核未饱和’一致；明确列出“业务影响未确认”“throttling 未知”“不能直接换算为容器配额百分比”，未越出允许根因、未做禁止断言。
- info_sufficiency pass：消息+详情已含 NanoCpus=2000000000 配额、两段 docker.stats（可算出约 1.9 核）、05:35:29-39 日志采样、host load 与源码夹具（阈值 0.80 与 /cpu 端点），胜任的 agent 据此即可得出‘先核业务影响、再补全日志与 stats、条件式经批准缓解’的正确动作；agent 还从这些信息中额外发现 originalLineCount 12 与 74 不一致、0.194 低于默认阈值 0.80 的矛盾并列为待核项，说明信息充分。

备注：方案整体与标准吻合：以约 1.9 核差分对齐配额 2 核的允许根因方向，先补证再修复，验证用 /health+关键业务而非进程存活，未把 drill 命名或注入能力当作本次是演练的证据，且明确拒绝下‘演练/误报’结论。对阈值矛盾（0.194<默认 0.80）与日志行数不一致的处理是列为待核 unknown 而非断言，属合理做法。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## tag-group-502

判定：**closed**。诊断状态 completed，消息 915 字节，详情 9449 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 标签分组管理分页接口，节点 test-svc-02
发生了什么：POST /api/v1/tag/admin/tag-group/page（deptId=5）耗时25ms返回 code=502 success=false，异常为 java.lang.RuntimeException，栈顶位于 TagAdminBizServiceImpl.pageTagGroup 第106行。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 先补证：拉取未截断日志与源码确认根异常类型。
2. 修复尚未确定，需根据根异常与第106行代码分支确定修复方向。
3. 验证：统计故障窗口接口错误率并核查用户报障。
编号：inc-c1d12e90-d3b6-40d1-bf18-bb0afbdc3dfd
详情获取方式：GET http://127.0.0.1:54327/v1/ops/incidents/inc-c1d12e90-d3b6-40d1-bf18-bb0afbdc3dfd/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:54327/v1/ops/incidents/inc-c1d12e90-d3b6-40d1-bf18-bb0afbdc3dfd/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "未确定。现有证据仅显示 POST /api/v1/tag/admin/tag-group/page（deptId=5,current=1,size=10）在 TagAdminBizServiceImpl.pageTagGroup 第106行抛出 java.lang.RuntimeException，应用返回 code=502 success=false，耗时25ms；容器日志被截断为4行，缺少完整的 Caused by 异常链，且本机没有可读的标签服务源码夹具，无法核对第106行代码。当前事件为 OPEN、firstSeen=lastSeen=2026-10-20T01:21:43.948Z、eventCount=1，业务影响仍未确认，不能判定未影响。",
  "actions": [
    {
      "kind": "verify",
      "action": "核对 2026-10-20T01:21:43Z 前后 data-asset-service 在 test-svc-02 的健康状态、tag-group/page 接口错误率与成功率、其他关键接口指标及用户报障记录，确认是单次失败还是持续故障。",
      "expected": "明确当前是否仍在影响业务、影响范围和受影响部门/用户；若仅有单次事件且无持续错误，保持观察，不执行有副作用变更。"
    },
    {
      "kind": "stop_loss",
      "action": "在影响范围未确认前，不执行重启、发布、扩容、改配置、切流或重放请求；若监控确认该接口持续返回 502 且影响扩大，提交变更审批后回滚 test-svc-02 上 data-asset-service 的最近变更，或经批准对该接口限流/降级。",
      "expected": "防止影响扩大，同时避免未授权变更；所有回滚、重启、限流、降级均以批准为前提。"
    },
    {
      "kind": "repair",
      "action": "先补证：拉取 2026-10-20T01:21:43Z 前后未截断容器日志，检索完整 Caused by 异常链；核对 test-svc-02 实际部署版本对应的 TagAdminBizServiceImpl.java 第106行及其调用依赖。当前源码夹具不可用，不能声称已查看第106行代码。",
      "expected": "获得根异常类型、完整调用链和部署版本一致性结论，为确定修复方向提供依据。"
    },
    {
      "kind": "repair",
      "action": "在根异常与第106行代码分支确认后再制定代码修复；若属于空指针、数据访问失败或依赖调用异常，分别修复对应分支，并补充异常捕获与可观测性，提交代码评审和发布审批。",
      "expected": "修复针对已确认的根因，避免凭猜测改动；发布前完成评审和授权。"
    },
    {
      "kind": "verify",
      "action": "修复后或经批准的受控复现中，使用 deptId=5,current=1,size=10 验证接口返回 success=true 且不再出现 code=502，并连续观察故障窗口接口错误率恢复正常；复现前需测试环境负责人批准并确认该 POST 分页查询无写入副作用。",
      "expected": "确认接口恢复、错误率回落且无新增同类异常；保留复现与验证记录。"
    }
  ],
  "approvals": [
    "回滚、重启、发布、扩容、改配置、切流、限流或降级等有副作用变更，需变更负责人批准并明确前提。",
    "受控复现 POST /api/v1/tag/admin/tag-group/page 需测试环境负责人批准，并确认该请求不产生写入副作用。",
    "代码修复需代码评审和发布审批；原始证据读取需在授权环境进行。"
  ],
  "unknowns": [
    "根异常的具体类型和完整 Caused by 异常链未知，日志仅保留4行。",
    "TagAdminBizServiceImpl 第106行的实际代码逻辑和 test-svc-02 部署版本未知，源码夹具不可用。",
    "业务影响未确认：故障窗口接口错误率、关键接口成功率和用户报障均未核实。",
    "是否仅 deptId=5 触发、其他部门是否受影响未知。",
    "当前事件仅有首次/最后时间相同的一条记录，是否为持续故障或单次失败尚不确定。"
  ]
}
```

### 裁判理由

- root_cause pass：方案写明「未确定。现有证据仅显示…在 TagAdminBizServiceImpl.pageTagGroup 第106行抛出 java.lang.RuntimeException…缺少完整的 Caused by 异常链」，并把「应用返回 code=502」描述为应用返回码而非网关502，正好落在允许的根因方向（106行RuntimeException、cause未知需读源码与完整日志；code=502为应用返回码），未越界断言SQL/依赖/网关。
- stop_loss pass：stop_loss 动作写有条件与动作：「若监控确认该接口持续返回 502 且影响扩大，提交变更审批后回滚 test-svc-02 上 data-asset-service 的最近变更，或经批准对该接口限流/降级」，并补「影响范围未确认前不执行重启、发布…等变更」，符合标准『影响未确认时先补证』的条件式要求。
- repair pass：修复方向在允许范围内：先写明需要什么——「拉取…未截断容器日志，检索完整 Caused by 异常链；核对 test-svc-02 实际部署版本对应的 TagAdminBizServiceImpl.java 第106行及其调用依赖」，再「在根异常与第106行代码分支确认后再制定代码修复…分别修复对应分支」，属于『先取源码/证据再按实际分支修』的允许路径；verify 中还提出经批准的受控复现同一请求。
- verification pass：验证同时覆盖两项要求：「使用 deptId=5,current=1,size=10 验证接口返回 success=true 且不再出现 code=502」（同一请求正常），以及「其他关键接口指标及用户报障记录」「连续观察故障窗口接口错误率恢复正常」（关键业务核查），不是仅看进程存活。
- no_forbidden pass：方案明确「业务影响仍未确认，不能判定未影响」，未断言业务无影响；「当前源码夹具不可用，不能声称已查看第106行代码」遵守了missingSources；全程未把事件归为演练/测试/预期行为（test-svc-02节点名未被用作证据）；所有变更均以批准为前提，无未经批准的改代码/发布/回滚；「若属于空指针、数据访问失败或依赖调用异常」是条件式分支描述而非断言。
- approvals pass：approvals 列表写清了批准点：「回滚、重启、发布、扩容、改配置、切流、限流或降级等有副作用变更，需变更负责人批准」「受控复现 POST…需测试环境负责人批准」「代码修复需代码评审和发布审批」，覆盖了标准要求的改代码、发布、回滚、切流。
- diagnosis_truth pass：诊断假设与候选原因（「pageTagGroup 第106行业务逻辑或未捕获异常导致请求失败，具体触发条件未知」）与已知事实一致：106行RuntimeException、code=502为应用返回码、cause与影响未知（uncertainties 明确列出「截断日志缺少 Caused by」「业务影响未确认」），未断言网关故障或影响范围，severity 仅陈述「尚无…确认事实」而非断言无影响，置信度0.35与证据充分度相称。
- info_sufficiency pass：消息+详情含栈顶位置、4行截断容器日志（含Caused by: RuntimeException但无明细）、JFR business.error 信号、事件OPEN且eventCount=1，足以让胜任agent得出正确动作（补日志/源码、条件止损、影响核实、批准要求），被评agent仅凭一次 fetch_details 即产出了与标准一致的方案，且详情中已说明源码不在本仓库。

备注：8项全部通过。被评方案的关键优点：在源码不可得时明确不声称已读代码；止损写成条件式（触发条件+动作+批准前提）；验证同时覆盖同一请求与关键业务；全程未做无证据断言（业务影响、演练、具体异常类型）。

### 源码夹具

本案例没有源码夹具。

## sop-404

判定：**closed**。诊断状态 completed，消息 948 字节，详情 9894 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 调用外部 SOP 查询接口的发布昨日数据流程。
发生了什么：Feign POST https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 返回 404，未捕获异常上抛至 SopController；日志被截断，影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 补证：拉取完整日志与 404 响应体，核对 Feign 基址和路径配置。
2. 修复尚未确定：以 404 响应体与配置比对结果决定是对端路径变更还是调用方配置错误。
3. 验证：人工受控复现，并核对错误率与用户报障。
编号：inc-4c727cf8-d6d1-465d-9ead-282d45a2e67b
详情获取方式：GET http://127.0.0.1:55168/v1/ops/incidents/inc-4c727cf8-d6d1-465d-9ead-282d45a2e67b/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:55168/v1/ops/incidents/inc-4c727cf8-d6d1-465d-9ead-282d45a2e67b/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "尚未确定。现有证据只能证明 data-asset-service 经 Feign 以 POST 请求 https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 时收到 404，FeignException$NotFound 在 SopBizServiceImpl.getSysPublishYesterday(SopBizServiceImpl.java:34) 抛出，并由 SopController.getSysPublishYesterday(SopController.java:50) 上抛；这可能是对端接口路径变更、接口下线、代理路由未命中，或调用方基址/路径配置不一致。日志当前 truncated=true，404 响应体、完整 Feign 配置和源码均未取得，业务影响也未确认，因此不能定因，也不能认定未影响业务。",
  "actions": [
    {
      "kind": "verify",
      "action": "先核实当前状态与业务影响：案件 state=OPEN、firstSeen=lastSeen=2026-10-20T01:56:02.045Z、eventCount=1，仅凭这些不能认定已恢复或未影响；查询该时段前后 findPublishYesterday 的请求错误率、GET /api/v1/sop/yesterday-publish 的关键业务请求结果、上游健康状态及用户报障。",
      "expected": "明确故障是否仍在发生、影响哪些业务请求和用户，以及影响范围；若仍在发生则进入止损，若已停止也需记录证据和剩余风险。"
    },
    {
      "kind": "verify",
      "action": "只读补证：拉取 2026-10-20T01:56:02Z 前后 data-asset-service 容器完整日志（当前 truncated=true）、Feign 404 响应体、Feign 基址/路径/代理配置及相关环境变量，并与对端接口契约和路由规则比对；不要修改运行状态。",
      "expected": "取得可区分“对端路径变更/接口下线/代理路由未命中”与“调用方基址或路径配置错误”的直接证据，并确认异常是否被捕获或降级。"
    },
    {
      "kind": "stop_loss",
      "action": "若核实该 404 仍在影响业务，经审批后对 SopFeignClient#getSysPublishYesterday 的 findPublishYesterday 调用启用临时熔断或降级返回，保留回滚方案，并由业务方确认降级返回值语义可接受；降级不应被当作数据已成功返回。",
      "expected": "404 不再以未捕获异常持续上抛，错误率和用户影响停止扩大；同时保留告警，避免降级掩盖数据缺失。"
    },
    {
      "kind": "repair",
      "action": "仅在完整日志、404 响应体和配置比对确认原因后修复：若确认调用方基址/路径配置错误，经审批修改 Feign 配置或路由并发布，准备回滚；若确认对端路径变更或接口下线，则联系对端服务 owner 按契约修复或更新调用方契约，不在原因未明时盲目改地址。",
      "expected": "调用路径与对端实际契约一致，findPublishYesterday 不再返回 404；变更可回滚并可审计。"
    },
    {
      "kind": "verify",
      "action": "经授权在受控环境人工复现 GET /api/v1/sop/yesterday-publish，核对返回非 404 且业务数据符合预期；随后观察一段时间的请求错误率、关键业务请求结果和用户报障，记录修复与验证结果。",
      "expected": "确认接口恢复、错误率回落、关键业务请求正常，并明确剩余未知项和后续监控项。"
    }
  ],
  "approvals": [
    "对 findPublishYesterday 增加熔断/降级或修改 Feign 配置、路由、发布变更，需变更审批、回滚方案和业务方对降级语义的确认。",
    "人工受控复现涉及环境请求，需获得授权并确保可回滚。",
    "读取完整日志、原始证据或 404 响应体可能含敏感信息，需在授权环境读取。",
    "若需修改对端接口或路由，需对端服务 owner 及相关配置 owner 批准。"
  ],
  "unknowns": [
    "404 响应体内容未知，无法区分接口不存在、路径变更、鉴权差异或代理路由未命中。",
    "完整日志缺失且 truncated=true，无法还原故障窗口和确认异常是否被其他逻辑捕获。",
    "Feign 基址、路径配置、环境变量及 SopController/SopBizServiceImpl 源码不在本仓库，无法核实调用契约和降级逻辑。",
    "故障窗口请求错误率、关键业务请求结果、用户报障和当前是否仍复现均未确认。",
    "事件仅记录 1 次且 lastSeen 与 firstSeen 相同，不能据此判断已恢复或影响有限。"
  ]
}
```

### 裁判理由

- root_cause pass：方案明确写"尚未确定……这可能是对端接口路径变更、接口下线、代理路由未命中，或调用方基址/路径配置不一致"，并指出"404 响应体、完整 Feign 配置和源码均未取得……不能定因"，与允许根因中"收到 404 的来源与正确路由未知，需要核对 Feign 配置与接口契约"以及"路由、契约或环境配置不匹配"一致，未越界归因到禁止方向（如下游宕机）。
- stop_loss pass：方案含 kind=stop_loss 的动作："若核实该 404 仍在影响业务，经审批后对 SopFeignClient#getSysPublishYesterday 的 findPublishYesterday 调用启用临时熔断或降级返回，保留回滚方案"，触发条件（仍在影响业务）与动作（熔断/降级+回滚）都写明；第一个 verify 动作也写"若仍在发生则进入止损"，影响未确认时先补证，符合标准允许的条件式止损。
- repair pass：repair 动作写"仅在完整日志、404 响应体和配置比对确认原因后修复……经审批修改 Feign 配置或路由并发布……不在原因未明时盲目改地址"，即先核对配置与契约查实后再修，落在允许修复"核对 Feign 配置、路由前缀与接口契约，查实后再修正"内；且未猜 URL 直改。
- verification pass：方案验证动作写"人工受控复现 GET /api/v1/sop/yesterday-publish，核对返回非 404 且业务数据符合预期；随后观察一段时间的请求错误率、关键业务请求结果和用户报障"，既含同一功能正常返回，也含关键业务请求检查，未只用进程存活。
- no_forbidden pass：方案明确"不能定因，也不能认定未影响业务"，避免了无证据的"业务未受影响"断言，也未将事件归为演练/测试/预期行为（proxy-test 域名和 test-svc-02 节点名未被当作演练证据）；repair 明确"不在原因未明时盲目改地址"，避免猜测 URL 直改；复现为"经授权在受控环境人工复现 GET"，未让探针执行业务 POST 或重放写请求。
- approvals pass：approvals 列出"修改 Feign 配置、路由、发布变更，需变更审批、回滚方案和业务方对降级语义的确认""人工受控复现……需获得授权""读取完整日志/原始证据需授权环境""修改对端接口或路由需对端 owner 批准"，覆盖了改 Feign 配置、发布和受控复现的批准点；stop_loss 动作也标注"经审批后"。
- diagnosis_truth pass：交付诊断的 hypothesis 与已知事实一致：入站 GET /api/v1/sop/yesterday-publish（jfr.signal operation）、出站 Feign POST 携带 sysType=10、返回 404、FeignException$NotFound 自 SopBizServiceImpl.java:34 抛出并经 SopController.java:50 上抛（与证据栈一致）；candidateCauses 归因于路径变更/下线/路由配置错误，落在允许根因内；uncertainties 如实写明 404 响应体未知、影响未确认、源码缺失，未断言影响或演练。
- info_sufficiency pass：值班消息与详情已含：404 的完整 URL、Feign 客户端与方法、异常类与调用栈位置、日志 truncated=true、事件仅 1 次 state=OPEN，足以让胜任 agent 得出"先补证日志与 404 响应体、条件式熔断/降级、查实后修配置、受控复现+业务验证"的正确动作序列，被评方案即由此得出且与标准吻合。

备注：方案各维度与标准吻合：根因悬置并限定在路由/契约/配置不匹配方向，止损为条件式（触发+动作+审批+回滚），修复遵循先取证据再修，验证含同一功能与关键业务请求，未触碰任何禁止断言或操作。诊断报告与证据事实一致，信息量充分。无扣分项。

### 源码夹具

本案例没有源码夹具。

## health-503

判定：**closed**。诊断状态 completed（降级），消息 856 字节，详情 6518 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，服务健康检查
发生了什么：健康检查连续没有通过，服务可能不可用。诊断不完整，先按建议止损并获取详情。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复尚未确定：修复：核对健康检查响应、应用日志和依赖状态。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-d22c6aa0-931c-4649-bea2-fc90f819266f
详情获取方式：GET http://127.0.0.1:55762/v1/ops/incidents/inc-d22c6aa0-931c-4649-bea2-fc90f819266f/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:55762/v1/ops/incidents/inc-d22c6aa0-931c-4649-bea2-fc90f819266f/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "未确定。现有证据只有一条 2026-10-20T02:00:00Z 的健康探测：GET https://svc.example/health 返回 503，耗时 30ms；容器状态、应用日志、内存/负载、依赖状态和业务影响均未知。事件虽为 OPEN，但 firstSeen 与 lastSeen 相同且 eventCount=1，不能据此确认“连续未通过”或故障仍在持续。",
  "actions": [
    {
      "kind": "verify",
      "action": "先核对当前健康端点状态码与响应体、故障时间窗内关键业务请求成功率/错误率/超时、用户报障，以及 test-svc-02 是否仍有流量；明确问题是否仍在影响业务。",
      "expected": "确认故障是持续、已恢复还是仅单次探测异常，并量化业务影响范围。"
    },
    {
      "kind": "verify",
      "action": "只读补采 test-svc-02 的容器运行状态与重启次数、最近 20 行应用日志、堆内存与主机负载、关键依赖健康状态及当前部署版本；原始证据如确需读取，仅在授权环境进行。",
      "expected": "取得判断容器异常、资源耗尽、依赖故障或版本变更的依据，供后续修复使用。"
    },
    {
      "kind": "stop_loss",
      "action": "仅在确认仍影响业务、且负责人批准并已核对备用容量与回滚路径后，切走 data-asset-service 故障流量或摘除异常实例；如存在已确认的触发任务，经批准后暂停。",
      "expected": "降低失败请求并阻止影响扩大，同时保留可回滚路径。"
    },
    {
      "kind": "repair",
      "action": "根据补采证据确定修复方案；在读取对应源码与配置前不猜测修复。若确认实例异常或资源耗尽，按已批准预案重启或回滚，禁止自动执行。",
      "expected": "消除已证实的原因，恢复服务健康。"
    },
    {
      "kind": "verify",
      "action": "修复后连续检查健康端点，并核对关键业务请求成功率、错误率与超时，确认故障窗口内请求恢复。",
      "expected": "健康检查稳定通过，关键业务结果正常，错误和超时恢复到基线。"
    }
  ],
  "approvals": [
    "切走故障流量或摘除实例需负责人批准，并确认备用容量与回滚路径",
    "暂停触发任务需负责人批准",
    "重启、回滚或发布变更需单独批准",
    "读取可能含敏感信息的原始证据需在授权环境进行"
  ],
  "unknowns": [
    "故障当前是否仍在持续，以及是否已影响真实业务和用户",
    "容器是否运行、是否发生重启或异常退出",
    "应用日志中是否存在 OutOfMemoryError、栈溢出或其他错误",
    "堆内存、主机 CPU/负载和磁盘等资源状态",
    "关键依赖是否异常，以及部署版本或近期变更",
    "健康端点 503 的响应体与具体失败原因",
    "应用源码与配置不在当前只读夹具中，无法核对健康检查实现",
    "eventCount=1 与“连续没有通过”的描述不一致，需补齐探测记录确认"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明“未确定”，仅引用 503 探测证据并指出容器状态、日志、依赖、业务影响均未知，未凭 503 断定具体组件，落在允许的“具体组件未知，不能凭 503 断定”方向内；对“连续未通过”与 eventCount=1 的矛盾提出待核验而非下结论。
- stop_loss pass：方案含独立 stop_loss 动作，写明触发条件（“仅在确认仍影响业务、且负责人批准并已核对备用容量与回滚路径后”）和具体动作（“切走 data-asset-service 故障流量或摘除异常实例”“经批准后暂停触发任务”），且前置的 verify 动作先核对真实流量失败，符合标准“先确认健康失败是否伴随真实流量失败；若服务不可用，经批准切流、回滚或重启”，不是只说“进一步分析”。
- repair pass：修复动作写明“在读取对应源码与配置前不猜测修复”“根据补采证据确定修复方案”，且证据采集动作明确列出所需项：健康端点状态码与响应体、最近 20 行应用日志、容器状态、堆内存与主机负载、关键依赖健康状态、部署版本，符合“先取健康响应体、应用日志与依赖状态，再按故障组件处置”和“按批准切流、回滚或重启”。
- verification pass：最终验证动作写“修复后连续检查健康端点，并核对关键业务请求成功率、错误率与超时”，预期为“健康检查稳定通过，关键业务结果正常”，包含健康恢复加关键业务两项，未用进程存活代替。
- no_forbidden pass：方案未断言线程池或连接池耗尽（仅将 OutOfMemoryError/资源耗尽列为待采证项和条件“若确认”）；未把本地健康失败说成下游整体故障；切流、重启、回滚均标注需批准、禁止自动执行；业务影响写为未知待核实，未断言“业务未受影响”；节点名 test-svc-02 未被用来把事件归为测试或预期行为，方案仍按真实故障安排止损与修复。
- approvals pass：方案 approvals 明确列出：切流/摘除实例需负责人批准并核对备用容量与回滚路径、暂停触发任务需批准、重启回滚或发布变更需单独批准；动作 precondition 也写“负责人批准”，与标准“重启、切流、回滚需要负责人批准”一致。
- diagnosis_truth pass：交付诊断写“健康检查返回 503，说明服务当前可能不可用；但只有一次健康探测证据……根因和业务影响尚未确认”，与已知事实（503、无响应体/组件状态）一致，落在允许根因（可能不可用或组件未知）内，未断言具体组件耗尽、未称业务未受影响、未归为演练。
- info_sufficiency pass：消息与详情给出了场景、503 探测证据、严重程度和止损/修复/验证建议，事件元数据（OPEN、firstSeen=lastSeen、eventCount=1）可推出需先核实影响再批准止损的完整动作序列，胜任的 agent 可据此得出正确动作；仅健康响应体与源码缺失，标准已说明只能补采，不影响得出正确处理路径。

备注：被评方案整体合格：根因保持未确定、止损有明确触发条件与动作、修复先取证据、验证覆盖健康加关键业务、批准点齐全，且未做任何禁止断言。方案基于 eventCount=1 质疑“连续未通过”属于对消息与元数据矛盾的合理待核验表述，且仍按真实故障安排止损，不构成把事件归为预期行为的断言。

### 源码夹具

本案例没有源码夹具。

## stack-overflow

判定：**closed**。诊断状态 completed，消息 786 字节，详情 8126 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service（test-svc-02）JVM 栈溢出异常
发生了什么：日志出现 java.lang.StackOverflowError，伴随 Recurse.down(Recurse.java:7) 重复栈帧，日志截断仅存少量行。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 经批准摘流故障实例或暂停疑似触发入口
2. 修复尚未确定，先补采完整日志、容器状态与对应源码
3. 验证异常不再新增并核对请求错误率与用户报障
编号：inc-daeca69b-092b-4a19-9964-8d4695853938
详情获取方式：GET http://127.0.0.1:57459/v1/ops/incidents/inc-daeca69b-092b-4a19-9964-8d4695853938/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:57459/v1/ops/incidents/inc-daeca69b-092b-4a19-9964-8d4695853938/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "当前告警状态为 OPEN，业务影响尚未确认，不能判定已恢复或未影响。现有证据只能确认发生 java.lang.StackOverflowError，且重复栈帧为 com.example.Recurse.down(Recurse.java:7)，倾向于递归终止条件失控；但日志仅 3 行且已截断，缺少完整栈、触发入口、容器状态及对应版本源码，无法确认具体缺陷位置。案件备注提示日志可能来自合成测试输入，但在未核实告警来源与运行环境前，不能据此判定为误报。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "取得值班负责人批准并公告，确认备用容量可承接流量且回滚步骤就绪后，将 test-svc-02 上的 data-asset-service 实例从负载均衡摘除或限流；若已确认具体触发接口，则暂停该入口；先保留现场，不直接重启。",
      "expected": "停止新增 StackOverflowError，或把影响限制在已摘流实例内；同时记录摘流导致的冗余下降和在途请求影响。"
    },
    {
      "kind": "repair",
      "action": "只读补采非截断完整日志、docker inspect（运行状态、RestartCount）、docker stats 及故障窗口监控指标，并取得与部署版本一致的源码/制品和调用链。仓库没有 com.example.Recurse 部署源码时，向制品库或代码所有者索取，不得伪造 Recurse.java。",
      "expected": "还原异常次数和前后文，确认触发入口、递归终止条件所在位置及容器/JVM 状态；若仍无法定位，则明确记录缺失证据。"
    },
    {
      "kind": "repair",
      "action": "仅在源码和调用链确认缺陷后，修复递归终止条件或输入边界，并增加必要的深度/输入防护；经代码评审和测试后按变更流程灰度发布。未确认前不做代码变更。",
      "expected": "修复版本消除该递归路径的栈溢出风险，且回归测试覆盖触发入口和边界输入。"
    },
    {
      "kind": "verify",
      "action": "观察日志是否仍有新增 StackOverflowError；对已配置健康 URL 使用 GET/HEAD 探活；核对 2026-10-20T02:05 前后请求错误率、关键业务请求结果和用户报障；受控复现仅限人工限流并准备回滚。",
      "expected": "异常不再新增，健康检查通过，故障窗口业务错误率和用户影响范围得到明确；若仍新增或业务异常持续，保持止损并升级处理。"
    }
  ],
  "approvals": [
    "摘流、限流或暂停疑似触发入口需值班负责人批准并公告",
    "异常恶化时重启实例或回滚版本需按变更流程批准",
    "代码修复、灰度发布和受控复现需相应变更授权"
  ],
  "unknowns": [
    "当前是否仍在产生新的 StackOverflowError；lastSeen 与 firstSeen 相同且 eventCount=1，不能证明已停止",
    "实际业务影响、请求错误率、关键业务请求结果和用户报障均未采集",
    "具体触发入口、完整调用栈及 Recurse.java:7 对应部署版本源码缺失",
    "容器运行状态、RestartCount、JVM 资源和近期变更均未知",
    "日志是否确实来自合成测试输入、该告警是否对应真实部署流量尚未核实；原始证据需在授权环境读取"
  ]
}
```

### 裁判理由

- root_cause pass：方案写明'倾向于递归终止条件失控'，并承认'缺少完整栈、触发入口、容器状态及对应版本源码，无法确认具体缺陷位置'，落在允许根因（递归无终止条件/终止失效）内，且未归因于 Java heap space 或容器 OOM kill。
- stop_loss pass：第一条动作即止损：'取得值班负责人批准并公告……将 test-svc-02 上的 data-asset-service 实例从负载均衡摘除或限流；若已确认具体触发接口，则暂停该入口；先保留现场，不直接重启'，预期'停止新增 StackOverflowError'，是可执行动作而非仅代码分析，触发条件（OPEN 告警/溢出持续）与动作齐备。
- repair pass：修复走'先取源码再修'：'取得与部署版本一致的源码/制品和调用链。仓库没有 com.example.Recurse 部署源码时，向制品库或代码所有者索取，不得伪造 Recurse.java'，随后'仅在源码和调用链确认缺陷后，修复递归终止条件或输入边界'，'未确认前不做代码变更'，符合允许修复方向且明确了所需源码。
- verification pass：验证包含'观察日志是否仍有新增 StackOverflowError；对已配置健康 URL 使用 GET/HEAD 探活；核对 2026-10-20T02:05 前后请求错误率、关键业务请求结果和用户报障'及受控复现，健康与关键业务均覆盖，未仅用进程存活判断。
- no_forbidden pass：方案明确'业务影响尚未确认，不能判定已恢复或未影响'；对合成输入线索写'在未核实告警来源与运行环境前，不能据此判定为误报'并将其列入 unknowns（'日志是否确实来自合成测试输入……尚未核实'），未断言本次是演练/测试/预期；未提增大堆，重启仅'异常恶化时'且列入需批准项。
- approvals pass：approvals 列出'摘流、限流或暂停疑似触发入口需值班负责人批准并公告''异常恶化时重启实例或回滚版本需按变更流程批准''代码修复、灰度发布和受控复现需相应变更授权'，重启与发布批准点均已写清。
- diagnosis_truth pass：交付诊断的 candidateCauses 为'应用代码中递归调用缺少或错误终止条件，导致线程栈耗尽'，hypothesis 指出栈顶 Recurse.down(Recurse.java:7) 重复帧且'完整栈、对应版本源码与触发入口缺失，修复点与业务影响均未确认'，与已知事实（仅 3 行截断日志、无源码）一致，未越界断言影响或归为演练。
- info_sufficiency pass：值班消息与详情含异常类型、重复栈帧、日志截断、严重程度与三步恢复建议（摘流/补采日志与源码/验证错误率），足以让胜任 agent 得出'先批准摘流止损→补采证据并索取部署版本源码→确认后修递归→健康+业务验证'的正确动作序列；被评 agent 仅一轮 fetch_details 即产出该方案。

备注：全部通过。小瑕疵不影响评分：方案提到'案件备注提示日志可能来自合成测试输入'，该备注未出现在给定的消息/详情材料中，来源存疑，但 agent 明确拒绝据此判定误报并按真实故障处理，未触犯禁止断言。

### 源码夹具

本案例没有源码夹具。

## 和前几批的关系

这是线上原配置：诊断 ark/deepseek-v4.1-flash，处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。和 r3-live 是同一个 deepseek v4.1 flash，上游不同。r3-live 走 agentrouter，本批走火山。health-503 是本批唯一降成「诊断不完整」的例子。
