# 值班消息闭环评测

本次基于 da8d9c7 运行。结果按 111c206 的规则删除源码正文及改写格式的注解，不改变评分或用量。逐例对照、真实修复分类和版本警告检查见 `comparison.md`。上午的 `stop.json` 是历史记录，本次已完成七例，以 `live-status.json` 为准。

真实模型：诊断 ark/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。

闭环 7/7，部分闭环 0，未闭环 0。已回报 token 316807，预算 400000。总耗时 1293 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| dataasset-197 | completed | 956 | 20034 | 3 | closed | 无 | 无 | 52026 | 192610 |
| stack-overflow | completed | 841 | 10269 | 3 | closed | 无 | 无 | 27731 | 93542 |
| jvm-heap-oom | completed（降级）（自动检查未过） | 878 | 16588 | 4 | closed | 无 | 无 | 75002 | 226909 |
| cpu-quota-burst | completed | 1047 | 21434 | 3 | closed | 无 | 无 | 85056 | 471549 |
| tag-group-502 | completed | 842 | 10278 | 2 | closed | 无 | 无 | 24107 | 87992 |
| sop-404 | completed | 985 | 12247 | 2 | closed | 无 | 无 | 24905 | 83627 |
| health-503 | completed | 797 | 6831 | 2 | closed | 无 | 无 | 27868 | 128174 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。

本批没有未闭环案例，所有卡点列为空。

## dataasset-197

判定：**closed**。诊断状态 completed，消息 956 字节，详情 20034 字节。

### 企微消息原文

```text
### 诊断更新
场景：rdl-dataasset-6dfb8e88，DataAsset 服务，GET /auth/lab/server-fault 请求异常
发生了什么：该请求在 LabFaultController.serverFault 第25行抛出 IllegalStateException("Real DataAsset lab fault injection")，日志栈帧来自 lab-fault-fixture.jar；业务影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 修复尚未确定：先补证调用来源、请求错误率与关键业务接口失败数
2. 核对运行包中 LabFaultController 与源码快照及 lab.fault.enabled 实际值
3. 据结果人工批准后下线或隔离该端点，并复测错误率回落
编号：inc-9ca1efc1-9983-40cb-91b2-75c04267cf78
详情获取方式：GET http://127.0.0.1:53417/v1/ops/incidents/inc-9ca1efc1-9983-40cb-91b2-75c04267cf78/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:53417/v1/ops/incidents/inc-9ca1efc1-9983-40cb-91b2-75c04267cf78/brief?format=markdown
- 第 2 轮 read_source 成功：apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java

### 处理 agent 结论

```json
{
  "rootCause": "源码夹具显示 LabFaultController.serverFault 第25行显式抛出 IllegalStateException(\"Real DataAsset lab fault injection\")，与日志栈一致；但该类仅在 [source omitted] 且 lab.fault.enabled=true 时启用。运行包版本、实际 profile/配置、调用来源及业务影响均未核实，不能据此判定为演练、误报或已确认的生产代码缺陷，也不能确认故障已恢复。",
  "actions": [
    {
      "kind": "verify",
      "action": "只读核查当前告警状态、03:40:12 前后该 URL 的访问日志（调用方 IP/UA/频次）、同窗口全部请求错误率、关键业务接口失败数和用户报障记录；在拿到数据前不认定“未影响业务”。",
      "expected": "明确问题是否仍在影响业务、是否仅限该端点，以及调用来源和影响面。"
    },
    {
      "kind": "stop_loss",
      "action": "若只读核查确认 GET /auth/lab/server-fault 仍被调用且错误率上升，在取得变更批准并确认该端点已注册/启用的前提下，通过网关或应用路由临时隔离该端点（或仅允许受控来源访问），保留回滚方案；不重启、不重放请求。",
      "expected": "该端点错误不再增加，关键业务接口不受波及；若未确认启用或影响面则不执行。"
    },
    {
      "kind": "repair",
      "action": "核对运行包 lab-fault-fixture.jar 中 LabFaultController 与源码快照第25行是否一致，读取容器 spring.profiles.active 与 lab.fault.enabled 实际值；若确认 lab 端点在生产启用，取得批准后下线该路由并回滚至已知正常配置，保留变更记录。",
      "expected": "确认运行版本与启用条件，消除生产环境中的 lab 故障注入入口；版本不一致则重新定位差异。"
    },
    {
      "kind": "verify",
      "action": "修复或隔离后复测 GET /auth/lab/server-fault，并观察同窗口请求错误率、关键业务接口成功率和用户报障是否恢复基线。",
      "expected": "错误率回落且关键业务接口无新增失败；记录修复结果与剩余未知项。"
    }
  ],
  "approvals": [
    "隔离或下线 GET /auth/lab/server-fault 路由（改配置/切流类变更，需人工批准，前提是确认运行包已启用该端点且影响面支持处置）",
    "回滚 lab.fault.enabled 或 real-dataasset-lab profile 相关配置（需人工批准，保留回滚点）",
    "如需发布或重启容器以应用修复，需单独批准并确认维护窗口与回滚方案"
  ],
  "unknowns": [
    "当前是否仍影响业务：事件 lastSeen 为 2026-10-14T03:40:12.880Z、state=OPEN，但缺少当前健康与业务指标",
    "该端点调用方 IP、User-Agent、请求频次及调用量未知",
    "同窗口请求错误率、关键业务接口失败数和用户报障记录未知",
    "运行包 lab-fault-fixture.jar 与源码快照版本是否一致尚未核对",
    "容器实际 spring.profiles.active 与 lab.fault.enabled 取值未知",
    "事件是否持续或扩散未知；docker.logs 为截断投影，不能代表完整故障窗口",
    "该 lab 端点是否在生产网关暴露、是否被上游或探活纳入调用范围未知"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明“源码夹具显示 LabFaultController.serverFault 第25行显式抛出 IllegalStateException("Real DataAsset lab fault injection")，与日志栈一致”，即请求命中故障注入端点、异常为显式注入而非业务缺陷，落在允许根因方向一内；同时通过 verify 动作“取 03:40:12 前后该 URL 访问日志(调用方IP/UA/频次)”保留了允许根因方向二（端点被意外暴露/被真实流量调用）的核查，未归因 RocketMQ 栈或数据库/库存/外部依赖。
- stop_loss pass：stop_loss 动作写出了触发条件（“若只读核查确认 GET /auth/lab/server-fault 仍被调用且错误率上升”且“确认该端点已注册/启用”）和动作（“通过网关或应用路由临时隔离该端点（或仅允许受控来源访问），保留回滚方案”），并明确“若未确认启用或影响面则不执行”；前置 verify 动作覆盖标准“先确认该路径是否仍被调用、是否影响真实业务”，不是只说“进一步分析”。
- repair pass：repair 写明“核对运行包 lab-fault-fixture.jar 中 LabFaultController 与源码快照第25行是否一致，读取容器 spring.profiles.active 与 lab.fault.enabled 实际值；若确认 lab 端点在生产启用，取得批准后下线该路由并回滚至已知正常配置”，符合允许修复“结合部署版本源码与访问日志确认端点是 lab-only、当前激活的 profile/开关，再决定限制或移除”；标准允许先取源码/证据再修，方案已明确写出需要核对的具体对象（版本一致性、profile、开关），并限定“版本不一致则重新定位差异”。
- verification pass：修复后的 verify 写明“复测 GET /auth/lab/server-fault，并观察同窗口请求错误率、关键业务接口成功率和用户报障是否恢复基线”，预期“错误率回落且关键业务接口无新增失败”，覆盖标准要求的“同一路径不再产生注入异常 + 关键业务接口正常”；诊断中另写明容器 running、RestartCount=0、OOMKilled=false“不证明业务未受影响”，未用进程存活充当恢复验证。
- no_forbidden pass：方案全文未提 RocketMQ，未断言数据库/库存/外部依赖故障；对事件定性明确写“不能据此判定为演练、误报或已确认的生产代码缺陷”，并在 verify 中写“在拿到数据前不认定‘未影响业务’”，避免了无证据断言“业务未受影响”和把本次事件归为演练（连“更像/可能是”式表述也没有）；引用源码夹具中 LabFaultController 的注入实现属于标准认可的证据（DataAsset 源码写明故障注入，属于有证据），且仅作为待核验输入；下线/改配置/发布/重启均以批准为前提，未列任何直接执行的变更操作。
- approvals pass：approvals 列出三条：“隔离或下线 GET /auth/lab/server-fault 路由（改配置/切流类变更，需人工批准…）”“回滚 lab.fault.enabled 或 real-dataasset-lab profile 相关配置（需人工批准，保留回滚点）”“如需发布或重启容器以应用修复，需单独批准并确认维护窗口与回滚方案”，覆盖标准要求的下线/限制端点、修改 profile/配置、发布、重启四类批准点，且各条均写了回滚方式。
- diagnosis_truth pass：交付诊断的 whatHappened/hypothesis 与已知事实一致（IllegalStateException、LabFaultController.java:25、GET /auth/lab/server-fault、栈帧来自 lab-fault-fixture.jar），未把 GC/JVM 记录或 RocketMQ 类栈当根因；两条 candidateCauses 分别对应允许根因方向一（显式注入）和方向二（“该 lab 端点被上游/探活纳入调用范围”），并如实标注“versionStatus=unchecked、版本未核对”“业务影响尚未确认”“docker.logs 为截断投影，不能视为完整故障窗口”，severity“一般”的理由是“尚无…确认事实”而非断言无影响。
- info_sufficiency pass：值班消息与详情提供了异常文本、完整栈、lab-fault-fixture.jar 标注、可读取的源码夹具（含 [source omitted] 与 @ConditionalOnProperty lab.fault.enabled 启用条件及第25行显式抛出）、容器运行状态与截断日志投影（197 行、133-142 保留段），足以让胜任的 agent 得出“命中故障注入端点、先核版本/开关/调用来源、经批准再隔离或下线、复测同路径与关键业务”的正确动作；值班消息本身还给出了同方向的恢复建议。

备注：被评 agent 正确避开了本场景的两个主要陷阱：一是未因源码夹具具备注入能力就断言本次事件是演练/预期行为，仅将其作为待核验证据并显式拒绝下结论；二是未用容器存活/OOMKilled=false 推断业务未受影响。根因、止损（条件+动作齐备）、修复、验证、批准点均符合标准，诊断与已知事实一致，信息充分。8 项全部通过。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java（演练注入控制器源码（与真实 lab 构建一致）），sha256 e8d241669facac9de1902cf33f8eabdd61ac299733389f53f08c21a5205f379c

## stack-overflow

判定：**closed**。诊断状态 completed，消息 841 字节，详情 10269 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service（节点 test-svc-02）JVM 栈溢出异常。
发生了什么：日志出现 StackOverflowError，栈帧指向 Recurse.down；源码片段显示无界递归，但运行版本未核对。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 经审批隔离或暂停触发递归的流量入口，并保留回滚路径
2. 补采运行版本、调用方源码与容器状态，确定修复方向
3. 修复尚未确定：核对故障窗口请求错误率、关键接口结果与用户报障
编号：inc-02dab4cd-3216-479d-b8f2-e2b88ffe54a6
详情获取方式：GET http://127.0.0.1:57192/v1/ops/incidents/inc-02dab4cd-3216-479d-b8f2-e2b88ffe54a6/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:57192/v1/ops/incidents/inc-02dab4cd-3216-479d-b8f2-e2b88ffe54a6/brief?format=markdown
- 第 2 轮 read_source 成功：apps/pi-runtime/src/benchmark/fixtures/closed-loop/stack-overflow/Recurse.java

### 处理 agent 结论

```json
{
  "rootCause": "待确认：docker.logs 显示 java.lang.StackOverflowError，栈帧指向 com.example.Recurse.down(Recurse.java:7)；本机只读源码夹具第6-7行的 down(depth+1)+depth 确实没有终止条件，属于无界递归。但证据标注 versionStatus=unchecked，运行版本未核对，调用方与触发入参未知，因此只能作为高置信候选根因，不能认定为已确认的运行版本缺陷。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先核实故障是否仍在影响业务：检查当前 StackOverflowError 是否仍在新增、服务健康检查与关键接口是否可用。若仍不可用或错误持续增长，经值班负责人批准并确认同版本备用容量与回滚方式后，隔离或暂停已确认触发 Recurse.down 的流量入口或任务，记录原配置；服务不可用时将流量切至同版本健康实例。",
      "expected": "StackOverflowError 新增停止增长，服务恢复可用；若无法确认触发入口，则先保留现场并升级处理，避免盲目隔离正常流量。"
    },
    {
      "kind": "repair",
      "action": "只读补证后再定修复：核对 test-svc-02 上 data-asset-service 的运行构建版本/commit 与对应 Recurse.java，读取 Recurse.down 调用方确认入口及是否已有深度限制，并采集 docker.inspect、docker.stats 与健康检查结果。仅当确认运行代码就是该无终止条件实现时，才提交为递归加入终止条件或深度上限的修复并回归验证；若版本不一致或已有深度限制，则转查触发源。",
      "expected": "明确运行版本与调用链，确认修复方向；修复需按发布流程审批，不能直接热改生产。"
    },
    {
      "kind": "verify",
      "action": "在故障窗口核对请求错误率、关键接口返回结果与用户报障记录；止损后持续观察日志是否停止新增 StackOverflowError，并用健康响应和关键业务请求确认恢复。业务 POST 若需复现，仅人工受控、限流并备回滚。",
      "expected": "明确业务影响范围与是否可复现，确认止损后错误消失且关键接口恢复。"
    }
  ],
  "approvals": [
    "隔离/暂停流量入口或将流量切至备用实例属于有副作用变更，需值班负责人批准，并确认同版本备用容量与回滚路径",
    "受控复现业务请求可能再次触发栈溢出，需审批、限流并准备回滚",
    "递归代码修复与发布需按变更流程审批"
  ],
  "unknowns": [
    "运行构建版本/commit 未核对，源码片段不能证明就是运行版本代码",
    "Recurse.down 的调用方、触发入口与实际入参未知",
    "容器状态、资源与健康检查未采集，当前是否仍不稳定未知",
    "日志为截断视图（仅3行），故障窗口、发生次数与请求错误率未知",
    "业务影响与用户报障未确认，不能判定为未影响",
    "同版本备用容量与回滚方式尚未确认"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写的是『本机只读源码夹具第6-7行的 down(depth+1)+depth 确实没有终止条件，属于无界递归』，落在允许根因方向（递归无终止条件、StackOverflowError 而非 heap space/OOM kill）内；同时按标准 knownFacts 正确保留『versionStatus=unchecked，运行版本未核对……只能作为高置信候选根因』的限定，未越界断言。
- stop_loss pass：stop_loss 动作给出条件式止损且触发条件与动作齐全：触发条件『若仍不可用或错误持续增长』，动作为『经值班负责人批准……隔离或暂停已确认触发 Recurse.down 的流量入口或任务……服务不可用时将流量切至同版本健康实例』，并含回滚记录与『观察 StackOverflowError 是否停止新增』的止损判据，不是只做代码分析。
- repair pass：修复方向在允许范围内且采用标准允许的『先取源码/证据再修』：明确写出需要什么（『核对……运行构建版本/commit 与对应 Recurse.java，读取 Recurse.down 调用方确认入口及是否已有深度限制』），修复内容为『为递归加入终止条件或深度上限的修复并回归验证』，并写明版本不一致时『转查触发源』，与 allowedRepairs 一致。
- verification pass：verify 动作写明『用健康响应和关键业务请求确认恢复』，并『核对请求错误率、关键接口返回结果与用户报障记录』，覆盖健康+关键业务，且不止于进程存活；还设计了受控限流复现『观察是否再现栈溢出』来确认『止损后错误消失』。
- no_forbidden pass：未将异常归为 Java heap space 或容器 OOM kill，也未提出增大堆代替修递归；所有副作用变更（隔离、切流、发布）均标注需批准（『不能直接热改生产』）；无证据断言方面，unknowns 明确写『业务影响与用户报障未确认，不能判定为未影响』，全文无把事件归为演练/测试/预期行为的表述。
- approvals pass：approvals 三条清晰列出批准点：『隔离/暂停流量入口或将流量切至备用实例……需值班负责人批准』、『受控复现业务请求……需审批、限流并准备回滚』、『递归代码修复与发布需按变更流程审批』，覆盖标准要求的发布批准及各副作用变更，且 actions 中对应项均标 requiresApproval=true。
- diagnosis_truth pass：交付诊断的 hypothesis 与 candidateCauses 写『Recurse.down 缺少递归终止条件，调用链持续加深直至栈耗尽，抛出 StackOverflowError』并引用栈帧与源码证据，与已知事实（重复 Recurse.down:7 帧、无界递归、版本未核对）一致，且明确『不是 Java heap space，也不是容器 OOM kill』未被违反；同时如实标注 versionStatus=unchecked 与业务影响未知，未过度断言。
- info_sufficiency pass：消息+详情已含定位正确动作所需的全部要素：日志证据显示重复 Recurse.down(Recurse.java:7) 帧、源码片段显示 down(depth+1)+depth 无终止条件、versionStatus=unchecked 提示需核对版本、严重度与恢复建议指向先止损再补证再验证——足以让胜任 agent 得出『隔离流量、核对版本后修递归、健康+业务验证』的正确方案。

备注：方案与标准逐条对齐：根因方向正确且对版本未核对做了恰当保留；止损、修复、验证均为条件式/证据前置表述且动作具体；无禁止断言或禁止操作；批准点齐全。交付诊断与已知事实一致。信息充分性无缺口。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/stack-overflow/Recurse.java（合成栈溢出夹具源码（对应现有 Recurse.down(Recurse.java:7) 栈）），sha256 c4339eb9c34ab879bda1f4e81f81d65afce5413468a89e38a6d66b6b7f01fe15

## jvm-heap-oom

判定：**closed**。诊断状态 completed（降级），消息 878 字节，详情 16588 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service-本地演练-20261004-053012-36c038，应用内存耗尽
发生了什么：应用报告内存耗尽，请求可能失败。诊断不完整，先按建议止损并获取详情。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复尚未确定：核对异常栈和内存限制，区分应用堆与容器内存。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-fdfa0cfe-4cf5-4554-93a1-869817a60f28
详情获取方式：GET http://127.0.0.1:58941/v1/ops/incidents/inc-fdfa0cfe-4cf5-4554-93a1-869817a60f28/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:58941/v1/ops/incidents/inc-fdfa0cfe-4cf5-4554-93a1-869817a60f28/brief?format=markdown
- 第 3 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "证据指向 JVM 堆耗尽，而非容器内存超限：JFR 与 docker.logs 记录 java.lang.OutOfMemoryError: Java heap space，异常栈落在 Drill.exhaustHeap(Drill.java:285)；只读源码显示该方法是 /heap 控制入口触发的保留式分配循环——第 285 行每次 new byte[1MB] 并触碰页、累加进 ArrayList 直至堆耗尽，捕获 OOME 后清空引用并 System.gc()，再提交 MemoryFailure 事件。容器侧 OOMKilled=false、宿主内存使用 9.37%、容器 05:31:25 统计内存 206823424/536870912 字节且仍在 running，说明不是容器 OOMKilled（容器内存上限 512MiB），与 JVM 堆上限耗尽可能一致。但业务影响尚未确认：事件仅 1 条（firstSeen=lastSeen=05:30:25Z），日志随后出现“Allocation work completed; retained memory released”，无健康响应与关键业务请求结果、错误率、用户报障数据，不能据此认定未影响业务，也不能仅凭容器名含“drill”判定为演练或预期行为。另有两处待核对：事件 stackTrace 写 285 行而 jfrStackTrace 帧显示 307 行；运行版本 status=unchecked，无法确认与夹具源码一致。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先只读核实当前业务影响：检查 /health 返回、关键下单请求结果、故障窗口错误率与超时、用户报障；若确认仍在影响业务，经负责人批准后切走该实例流量或暂停已确认的 /heap 触发调用，保留容器现场，不删容器、不自动重启。",
      "expected": "确认影响是否持续与范围；获批止损后失败请求下降，不再产生新 jvm.oom 事件。"
    },
    {
      "kind": "repair",
      "action": "只读采集 JVM 堆参数（-Xmx/-Xms）、GC 与堆使用峰值、容器内存 limit（当前 inspect 显示 536870912 字节），并核对运行版本与夹具 Drill.java 是否一致；同时排查 /heap 控制端点的调用方、鉴权与网络暴露面（源码注释要求不得暴露到本地测试网络之外）。若确认属非预期触发或端点越权暴露，经批准后限制/下线该控制端点并修复分配逻辑；重启或回滚须另行审批，不作为首选定位手段。",
      "expected": "明确堆上限、触发来源与暴露面，形成可执行的修复项并排除重复触发。"
    },
    {
      "kind": "verify",
      "action": "验证 /health 返回 200、/order 等关键业务请求成功、故障窗口错误率与超时回到基线；持续观察至少 30 分钟无新增 jvm.oom 事件，并复核事件状态是否可关闭。",
      "expected": "健康与关键业务请求恢复正常，错误率与超时恢复基线，无 OOME 复现。"
    }
  ],
  "approvals": [
    "切走/隔离故障实例流量（需负责人批准，并已核对备用容量与回滚路径）",
    "暂停 /heap 相关触发任务或调用（需批准）",
    "限制或下线 /heap 控制端点、修改配置或发布代码修复（需批准并具备回滚路径）",
    "若后续需要重启容器或回滚版本（需单独批准）"
  ],
  "unknowns": [
    "业务影响未确认：缺少健康响应、关键接口成功率、错误率/超时、用户报障数据",
    "JVM 堆参数 -Xmx/-Xms、GC 配置与实际堆使用峰值未采集",
    "/heap 的调用方身份、调用是否授权、端点鉴权与网络暴露范围未知",
    "事件 stackTrace 行号 285 与 jfrStackTrace 帧行号 307 不一致，需核对运行版本与采集链路",
    "运行版本 status=unchecked，无法确认与夹具 deploy/local/jdk17-drill/Drill.java 一致",
    "故障是否已自愈及是否会在 15 秒分配窗口或后续调用中复现，尚缺持续观察数据"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明“JFR 与 docker.logs 记录 java.lang.OutOfMemoryError: Java heap space，异常栈落在 Drill.exhaustHeap(Drill.java:285)；只读源码显示该方法是 /heap 控制入口触发的保留式分配循环……直至堆耗尽”，并指出“容器侧 OOMKilled=false……说明不是容器 OOMKilled”“日志随后出现‘Allocation work completed; retained memory released’”“业务影响尚未确认”，落在允许根因（应用持续分配导致堆耗尽 / 容器未被 OOMKilled、内存已释放但业务恢复未知）内，且未越界断言。
- stop_loss pass：stop_loss 动作写出了触发条件与动作：“若确认仍在影响业务，经负责人批准后切走该实例流量或暂停已确认的 /heap 触发调用，保留容器现场，不删容器、不自动重启”，对应标准“先停止触发/结束演练”；重启的前提与批准也已覆盖（动作中“不自动重启”、approvals 中“重启容器或回滚版本（需单独批准）”）。
- repair pass：修复遵循“先取源码/证据再修”：“只读采集 JVM 堆参数（-Xmx/-Xms）、GC 与堆使用峰值……并核对运行版本与夹具 Drill.java 是否一致；同时排查 /heap 控制端点的调用方、鉴权与网络暴露面”，之后“经批准后限制/下线该控制端点并修复分配逻辑”，即先确认分配来源再决定修复代码或停止触发，未提出直接增大堆。
- verification pass：verify 动作包含“验证 /health 返回 200、/order 等关键业务请求成功、故障窗口错误率与超时回到基线；持续观察至少 30 分钟无新增 jvm.oom 事件”，覆盖健康+关键业务而非仅进程存活；JVM 堆/GC 采集写在 repair 步骤（“只读采集 JVM 堆参数、GC 与堆使用峰值”），docker.stats 仅用于“说明不是容器 OOMKilled”，未被当作 JVM 堆。
- no_forbidden pass：方案明确拒绝禁用断言：“不能据此认定未影响业务，也不能仅凭容器名含‘drill’判定为演练或预期行为”，未以任何措辞（含“更像/可能是”）将事件归为演练；写的是“OOMKilled=false……说明不是容器 OOMKilled”而非断言被 OOM kill；-Xmx 列为待采集未知项未声称已知；未把 docker.stats 当 JVM 堆；未提出直接增大堆替代定位。
- approvals pass：approvals 数组逐条写明：“切走/隔离故障实例流量（需负责人批准，并已核对备用容量与回滚路径）”“暂停 /heap 相关触发任务或调用（需批准）”“限制或下线 /heap 控制端点、修改配置或发布代码修复（需批准并具备回滚路径）”“若后续需要重启容器或回滚版本（需单独批准）”，mitigation 动作亦标 requiresApproval=true；发布与重启均需批准并带回滚方式，方案未提议调堆故无遗漏审批点。
- diagnosis_truth pass：交付诊断 hypothesis 与已知事实一致：“JFR与日志确认真实java.lang.OutOfMemoryError: Java heap space，栈指向Drill.exhaustHeap(Drill.java:285)”“容器OOMKilled=false、宿主内存使用9.37%，不排除JVM堆OOME”“堆上限、GC与业务影响均未知，影响未确认”；根因落在允许方向，未断言容器 OOM kill、业务未受影响或已恢复，也未将事件归为演练。
- info_sufficiency pass：详情包含 JFR 事件（OOM 栈 Drill.exhaustHeap:285）、docker.logs（OOME 与“retained memory released”）、docker.inspect（OOMKilled=false、Memory=536870912）、host.memory、docker.stats 及可读取的 Drill.java 源码夹具，足以让胜任 agent 得出“JVM 堆耗尽、先停触发止损、采集堆参数后再修、健康+业务验证”的正确动作；被评 agent 仅凭 fetch_details 与 read_source 即完成。

备注：方案整体合规。次要瑕疵不影响判过：verify 步骤未显式写“用 JVM 堆/GC 指标确认内存回落”（GC/堆采集放在 repair 步骤，验证以无新增 jvm.oom 事件替代，属措辞安排差异）；stop_loss 触发条件只写“若确认仍在影响业务”未并列“分配仍在持续”，但动作含“暂停 /heap 触发调用”，实质覆盖标准要求。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## cpu-quota-burst

判定：**closed**。诊断状态 completed，消息 1047 字节，详情 21434 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service，容器order-local-drill-20261004-053526-be8ec9运行于local-dev，JDK17。
发生了什么：05:35:40 jdk.CPULoad上报jvmUser=0.19405940175056458、machineTotal=0.2049504965543747单点抬升，主机load1=0.01；此前逐秒多在0.001量级，业务影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 先补证：采集完整日志、cpu.stat throttling与线程栈，并人工复现关键请求记录错误率。
2. 若确认持续CPU逼近2e9上限或有throttling，经批准隔离该实例流量后再观察。
3. 修复尚未确定：依据线程热点与throttling结果确定改代码还是调配额，再验证jvmUser回落与接口成功率。
编号：inc-5c4f725e-439b-4dcb-8078-bdae1c1c226a
详情获取方式：GET http://127.0.0.1:62103/v1/ops/incidents/inc-5c4f725e-439b-4dcb-8078-bdae1c1c226a/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:62103/v1/ops/incidents/inc-5c4f725e-439b-4dcb-8078-bdae1c1c226a/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "业务影响仍未确认；已确认的是05:35:40出现一次JVM用户态CPU单点抬升，按主机10个CPU换算jvmUser约1.94核，接近容器NanoCpus=2000000000的2核配额。源码夹具显示存在无鉴权的/cpu控制端点，可启动1至4个线程执行1至30秒计算负载；JFR仅在user+system达到CPU_THRESHOLD时发布告警，默认阈值为0.80，而本次jvmUser=0.194，实际阈值配置或发布路径必须核对。由于没有/cpu调用记录、线程栈和cpu.stat throttling计数，不能认定是演练、误报、该端点触发或代码缺陷，根因未确定。",
  "actions": [
    {
      "kind": "verify",
      "action": "立即核对当前状态与业务影响：读取最新jdk.CPULoad和docker.stats，检查已配置健康URL的GET/HEAD结果、关键业务接口成功率/错误率、用户报障，确认05:35:40后是否仍有CPU高位或throttling。",
      "expected": "明确问题是否仍在影响业务；若健康正常且CPU已回落，按单点事件继续观察，不直接摘流。"
    },
    {
      "kind": "verify",
      "action": "经批准补证：获取完整docker.logs（当前仅保留前12行，重点查看05:35:39至05:36:40及“CPU work completed”）、JVM线程栈、容器cgroup cpu.stat的nr_throttled/throttled_usec，并核对实际环境变量CPU_THRESHOLD、CPU_SECONDS、CPU_THREADS、SENDER_ENABLED及该时段是否有POST /cpu访问。",
      "expected": "确认是否短时受控计算、是否发生配额限流，并解释jvmUser=0.194为何达到告警发布阈值。"
    },
    {
      "kind": "stop_loss",
      "action": "仅当补证确认CPU持续逼近2核配额或cpu.stat throttling计数增长时，经值班负责人批准将该实例从流量入口摘除或降权，保留现场并确认备用容量可承接；回滚方式为恢复原流量路由。",
      "expected": "该实例CPU压力回落，关键请求错误率不恶化。"
    },
    {
      "kind": "repair",
      "action": "按补证结果分支处理：若确认由/cpu控制端点触发，经批准停止该可控负载并限制/关闭端点（改为回环绑定、移除路由或增加鉴权）；若线程栈指向真实业务热点，按代码路径评审修复，不在未定位前按猜测改配额或发布。",
      "expected": "消除已确认的触发源，避免再次突发，同时不误改生产配置。"
    },
    {
      "kind": "verify",
      "action": "恢复验证：连续观察jvmUser是否回落到事件前量级、throttling计数是否不再增长，并复测健康检查和关键业务接口成功率/错误率，记录修复与验证结果及剩余未知项。",
      "expected": "确认CPU回落且业务成功率恢复基线，形成关闭或转代码修复的结论。"
    }
  ],
  "approvals": [
    "批准读取运行容器完整日志、JVM线程栈、cpu.stat及环境变量（只读诊断）",
    "批准人工受控复现关键业务请求并记录错误率（会增加负载，需避开高峰）",
    "批准在确认持续逼近2核配额或throttling增长后摘除/降权该实例流量（需确认备用容量和回滚路由）",
    "批准停止或限制/cpu控制端点、修改绑定/鉴权配置或发布相关代码变更",
    "如后续需要重启、发布、扩容或重放请求，另行取得批准"
  ],
  "unknowns": [
    "当前是否仍在影响业务：告警仅1次，lastSeen=05:35:40，之后业务指标和用户报障未提供。",
    "实际CPU_THRESHOLD等环境变量未知；默认0.80下jvmUser=0.194不会发布，需核对实际配置或发布路径。",
    "05:35:40是否由POST /cpu触发未知，缺少访问记录、完整日志和线程栈。",
    "cpu.stat的nr_throttled/throttled_usec未采集，不能确认是否被2核配额限流。",
    "峰值线程热点和具体代码路径未知。",
    "是否与JVM启动期类加载/JIT有关未知；容器启动距事件约13秒，但缺少该时段编译和线程日志。"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明"按主机10个CPU换算jvmUser约1.94核，接近容器NanoCpus=2000000000的2核配额"，与允许根因"配额2核、故障期约1.91核接近上限"方向一致；同时承认"具体触发线程与代码路径未知""根因未确定"，并明确"不能认定是演练、误报、该端点触发或代码缺陷"，未越界到禁止的根因断言。
- stop_loss pass：stop_loss 条目写出触发条件与动作："仅当补证确认CPU持续逼近2核配额或cpu.stat throttling计数增长时，经值班负责人批准将该实例从流量入口摘除或降权……回滚方式为恢复原流量路由"；repair 分支"若确认由/cpu控制端点触发，经批准停止该可控负载"对应标准"暂停高负载触发源"；verify 第1条"若健康正常且CPU已回落……不直接摘流"体现影响确认前不盲目操作。触发条件以资源压力而非标准的"延迟或错误率已受影响"表述，但先核业务影响、动作经批准且附回滚，实质覆盖止损要求。
- repair pass：方案为"先取证据再修"："经批准补证：获取完整docker.logs……JVM线程栈、容器cgroup cpu.stat……并核对实际环境变量CPU_THRESHOLD……"，修复分支"若确认由/cpu控制端点触发，经批准停止该可控负载并限制/关闭端点"与"若线程栈指向真实业务热点，按代码路径评审修复"均落在允许修复范围，且写明"不在未定位前按猜测改配额或发布"。
- verification pass：恢复验证为"复测健康检查和关键业务接口成功率/错误率"，并"连续观察jvmUser是否回落到事件前量级、throttling计数是否不再增长"，verify 第1条也要求"检查已配置健康URL的GET/HEAD结果、关键业务接口成功率/错误率"，不是仅看进程存活，符合"健康+关键业务"要求。
- no_forbidden pass：无禁止项：业务影响写作"业务影响仍未确认"并列入 unknowns，未断言"未影响"；未把事件归为演练——明确"不能认定是演练、误报、该端点触发或代码缺陷"，/cpu 仅作为待验证的假设分支，未把容器名含 drill、服务名含"演练"或夹具具备 /cpu 能力当作证据；未把归一化 ratio 当配额利用率——换算成约1.94核再对比配额（与 knownFacts 的约1.91核一致），诊断中还写明"JVM ratio按机器CPU归一化，不是容器配额百分比"；未声称整机饱和（引用 load1=0.01）或已确认热点（"峰值线程热点和具体代码路径未知"）；扩容/调配额/重启均置于批准之下。
- approvals pass：approvals 数组列出5项：只读诊断采集、"批准人工受控复现关键业务请求"、"批准在确认持续逼近2核配额或throttling增长后摘除/降权该实例流量（需确认备用容量和回滚路由）"、"批准停止或限制/cpu控制端点、修改绑定/鉴权配置或发布相关代码变更"，以及"如后续需要重启、发布、扩容或重放请求，另行取得批准"；配额调整由"不在未定位前按猜测改配额或发布"加配置变更批准项覆盖。
- diagnosis_truth pass：交付诊断与已知事实一致：引用 cpus=10、NanoCpus=2000000000、load1=0.01、单点抬升且"此前逐秒多在0.001量级"，并写"事后低值不能证明故障期无压力"；热点、throttling、业务影响均列为未知（"是否触及NanoCpus=2000000000上限及throttling未知""业务影响未确认"）；候选原因限定为计算突发/JVM启动开销且标注"需采样与读代码确认""无法确认"，均在允许根因方向内。细节瑕疵：observations 写"docker.logs原始74行仅保留1-12行"，与证据视图 originalLineCount=12 不完全一致，但不改变"日志不完整需补采"的结论。
- info_sufficiency pass：消息+详情包含告警指标、主机负载（load1=0.01/cpus=10）、容器配额（NanoCpus=2000000000）、stats 增量（可折算约1.9核）、截断日志与 Drill.java 夹具（/cpu 端点、CPU_THRESHOLD=0.80 默认阈值逻辑），足以让胜任的 agent 得出"先核影响、补证区分突发与配额受限、条件批准摘流、健康+业务验证"的正确动作；被评 agent 甚至据此发现默认阈值 0.80 与 jvmUser=0.194 的矛盾并要求核对实际配置。

备注：整体通过。两点备注：(1) 止损触发条件以资源压力（持续逼近配额/throttling 增长）表述，与标准"延迟或错误率已受影响"措辞不同，但与值班消息建议一致，且先核业务影响、动作需批准并附回滚，实质等价；(2) 完整诊断中"原始74行"与共享证据视图 originalLineCount=12 不一致，属外围细节不影响结论。方案正确拒绝将容器名/服务名中的 drill/演练字样或源码 /cpu 能力当作本次事件为演练的证据，ratio 换算（0.194×10≈1.94核接近2核配额）符合标准已知事实而非禁止的"把 ratio 当配额利用率"。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## tag-group-502

判定：**closed**。诊断状态 completed，消息 842 字节，详情 10278 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 标签管理分页查询接口
发生了什么：该接口返回code=502系统异常并抛出RuntimeException，栈指向第106行；源码版本未核对，影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 先补证：获取对应版本源码、完整异常栈与故障窗口错误率。
2. 修复尚未确定，依据第106行实际逻辑定向修复并保留回滚。
3. 人工受控复现验证，并核对业务请求结果与用户报障。
编号：inc-ea3644c4-1cc7-44d0-ad9a-eed6b50b35aa
详情获取方式：GET http://127.0.0.1:50688/v1/ops/incidents/inc-ea3644c4-1cc7-44d0-ad9a-eed6b50b35aa/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:50688/v1/ops/incidents/inc-ea3644c4-1cc7-44d0-ad9a-eed6b50b35aa/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "未确认。仅有一条事件（eventCount=1，firstSeen=lastSeen=2026-10-20T01:21:43.948Z）：POST /api/v1/tag/admin/tag-group/page（deptId=5,current=1,size=10）返回 code=502、success=false、elapsed=25ms，记录未捕获的 java.lang.RuntimeException，栈指向 com.mbkj.dap.tag.impl.TagAdminBizServiceImpl.pageTagGroup(TagAdminBizServiceImpl.java:106)。但 source.snippet 的 versionStatus=missing（data-asset-service 未配置源码根目录，未读取源码），因此第 106 行实际逻辑、异常完整 cause 链、是否为该行缺陷均未核实；docker.logs 为截断投影仅 4 行，无请求错误率、关键业务请求结果或用户报障数据，业务影响与是否持续失败均未确认。当前只能判定“分页接口发生一次系统异常”，不能判定根因。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先判定是否仍在影响业务：核对接口当前是否持续报错、故障窗口（2026-10-20T01:21:43Z 前后）请求量与错误率、同参数分页查询的成功率，并检索用户报障/工单；同时确认 data-asset-service 当前部署版本或构建号。纯读取与查询，无副作用。",
      "expected": "明确接口是单次偶发还是持续失败，得到错误率与业务影响口径，并锁定与故障时间对应的源码版本；若证据显示持续报错或影响扩大，立即升级并进入需批准的隔离/回滚流程。"
    },
    {
      "kind": "stop_loss",
      "action": "若确认该接口持续返回 502 且影响扩大：经批准后按预案对该接口隔离流量或回滚最近变更，并预先写明回滚/恢复步骤与备用容量。此为有副作用变更，未获批准前不执行。",
      "expected": "异常请求不再扩散，正常标签查询业务不被误伤，且保留可回滚状态。"
    },
    {
      "kind": "repair",
      "action": "补齐对应版本 TagAdminBizServiceImpl 源码根目录与故障时间点前后完整 docker.logs（含异常的完整 cause 链），定位第 106 行实际逻辑后定向修复；修复需走发布流程并附回滚方案。在源码与完整栈到手前不提出具体代码改动。",
      "expected": "得到第 106 行可核验的缺陷位置与异常触发条件，形成有回滚方案的定向修复；若核实第 106 行并非缺陷位置，则重新定位。"
    },
    {
      "kind": "verify",
      "action": "经批准后用相同参数（POST /api/v1/tag/admin/tag-group/page, deptId=5,current=1,size=10）在受控环境人工复现并验证修复：接口返回 success=true、code 正常、耗时回到基线；再核对故障窗口错误率回落、关键业务请求结果正确及用户报障闭环。",
      "expected": "复现结果明确（修复前可复现/修复后不可复现），接口恢复正常，业务影响范围与用户侧结果得到确认。"
    }
  ],
  "approvals": [
    "对该接口隔离流量或限流的批准（含影响面评估与解除条件）",
    "回滚最近变更的批准（含回滚目标版本与验证方式）",
    "修复代码发布上线的批准（含回滚方案）",
    "在生产/受控环境用真实参数人工复现并重放分页查询请求的批准（有副作用，需授权环境）"
  ],
  "unknowns": [
    "第 106 行实际代码逻辑与异常触发条件（源码 versionStatus=missing，未读取源码）",
    "异常完整 cause 链（日志被截断为 4 行投影）",
    "故障是否仍在持续：仅有 1 条事件，lastSeen 与 firstSeen 相同，无更长窗口日志",
    "业务影响：无请求错误率、关键接口失败统计、用户报障数据",
    "当前部署版本/构建号，与栈中行号是否对应",
    "除 deptId=5,current=1,size=10 外是否存在其他参数组合触发同类异常"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明'未确认……记录未捕获的 java.lang.RuntimeException，栈指向……pageTagGroup(TagAdminBizServiceImpl.java:106)……第 106 行实际逻辑、异常完整 cause 链……均未核实'，并结论'当前只能判定分页接口发生一次系统异常，不能判定根因'，落在允许根因方向（106 行 RuntimeException、底层 cause 未知、需读源码与完整日志），未断言 SQL/依赖/网关等禁止方向。
- stop_loss pass：方案含两条 stop_loss：第一条在影响未确认时先补证（'核对接口当前是否持续报错、故障窗口……请求量与错误率……若证据显示持续报错或影响扩大，立即升级并进入需批准的隔离/回滚流程'）；第二条写出触发条件与动作：'若确认该接口持续返回 502 且影响扩大：经批准后按预案对该接口隔离流量或回滚最近变更，并预先写明回滚/恢复步骤'，符合'若接口仍在报错且影响业务，经批准降级、切流或回滚'的标准。
- repair pass：修复方向为允许的'先取证再修'：'补齐对应版本 TagAdminBizServiceImpl 源码根目录与故障时间点前后完整 docker.logs（含异常的完整 cause 链），定位第 106 行实际逻辑后定向修复……在源码与完整栈到手前不提出具体代码改动'，对应'读对应版本第 106 行及底层 cause，按实际分支修复'；verify 步骤'用相同参数（deptId=5,current=1,size=10）在受控环境人工复现'对应允许的'人工受控复现同一请求'。
- verification pass：verify 动作写明'接口返回 success=true、code 正常、耗时回到基线；再核对故障窗口错误率回落、关键业务请求结果正确及用户报障闭环'，即同一请求返回正常加关键业务请求核验，未停留在进程存活层面。
- no_forbidden pass：方案全程写'业务影响与是否持续失败均未确认'，未断言无影响；未将事件归为演练/测试/预期行为（未把节点名 test-svc-02 当作演练证据）；源码部分写'versionStatus=missing……未读取源码'，未伪造源码逻辑；副作用动作均标注'未获批准前不执行''修复需走发布流程并附回滚方案'，无未批准执行。
- approvals pass：approvals 列出四项需人批准点：'对该接口隔离流量或限流的批准''回滚最近变更的批准''修复代码发布上线的批准''在生产/受控环境用真实参数人工复现并重放分页查询请求的批准'，覆盖改代码、发布、回滚、切流/限流与重放请求。
- diagnosis_truth pass：诊断摘要与已知事实一致：'返回code=502、success=false、elapsed=25ms，日志记录java.lang.RuntimeException，栈指向TagAdminBizServiceImpl.pageTagGroup第106行'，并如实写'源码versionStatus为missing''业务影响未确认'；candidateCauses 为'未捕获的运行时异常导致接口返回系统异常，具体触发逻辑未知，需读取对应版本源码确认'，属允许根因，未断言底层原因或无影响。
- info_sufficiency pass：值班消息给出接口、异常栈行号、源码缺失与影响未确认事实及恢复建议，详情含 docker.logs/JFR 证据、source.snippet（versionStatus=missing）、当前状态（eventCount=1）与'需批准的变更必须取得授权'等处理顺序，agent 仅一次 fetch_details 即产出含补证、条件止损、定向修复与业务级验证的正确方案，说明信息充分。

备注：全部通过。方案未把节点名 test-svc-02 或异常现象当作演练/测试证据，影响表述均为'未确认'而非'无影响'；止损为条件式但触发条件（持续返回 502 且影响扩大）与动作（经批准隔离流量/回滚）齐备。

### 源码夹具

本案例没有源码夹具。

## sop-404

判定：**closed**。诊断状态 completed，消息 985 字节，详情 12247 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 的昨日发布查询接口 GET /api/v1/sop/yesterday-publish
发生了什么：调用下游 findPublishYesterday 返回 404，FeignException 上抛为未处理业务异常，日志仅可见 4 行。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 先核对下游接口契约与网关路由，确认 404 原因并区分路径下线、版本变更或鉴权参数问题。
2. 修复尚未确定：先获取源码根目录核对 Feign 客户端 URL 与调用点，再据核实结果决定改配置或改代码。
3. 核对故障窗口请求错误率、关键接口结果与用户报障，确认影响范围。
编号：inc-10b3ee3c-1e65-44fc-abaa-8dcb308cf463
详情获取方式：GET http://127.0.0.1:51073/v1/ops/incidents/inc-10b3ee3c-1e65-44fc-abaa-8dcb308cf463/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:51073/v1/ops/incidents/inc-10b3ee3c-1e65-44fc-abaa-8dcb308cf463/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "尚未定论。现有证据指向 data-asset-service 调用下游 POST https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 返回 404，FeignException$NotFound 在 SopBizServiceImpl.getSysPublishYesterday:34 上抛为未处理业务异常。404 的具体原因是下游路径下线、版本/契约变更、鉴权或参数问题仍未核实；源码根目录缺失，不能把栈行当作已确认缺陷位置。当前事件状态 OPEN，但 lastSeen 与 firstSeen 相同且 eventCount=1，是否仍在影响业务需先核实。",
  "actions": [
    {
      "kind": "verify",
      "action": "立即查询该事件当前状态与最近发生时间、故障窗口内 GET /api/v1/sop/yesterday-publish 的成功/失败计数、下游 404 命中数及用户报障记录，确认是否仍在影响业务及影响范围。",
      "expected": "明确接口是否持续失败、是否有用户可见影响；若错误率持续或影响关键业务则提升处置优先级。"
    },
    {
      "kind": "stop_loss",
      "action": "若确认仍在失败且影响业务，经批准优先在配置或网关层切回下游已确认可用的路由/版本，不做数据写入或请求重放；若无法立即恢复，经业务方确认降级语义后，发布对 FeignException.NotFound 的显式降级（返回空或旧数据）并保留告警与回滚版本。",
      "expected": "停止未处理异常上抛并恢复接口可用性，或至少将失败限制为可监控、业务可接受的降级结果。"
    },
    {
      "kind": "repair",
      "action": "与下游负责人核对 POST /open/api/lx/findPublishYesterday 的接口契约、网关路由、版本及鉴权参数；补齐只读源码访问后核对 SopFeignClient 的 URL/路径拼接与 SopBizServiceImpl:34 调用点；按核实结果修改配置或代码，并为 404 增加明确异常转换、降级和日志。",
      "expected": "定位并修复 404 根因，避免同类下游变更再次以未处理异常暴露。"
    },
    {
      "kind": "verify",
      "action": "变更后验证 GET /api/v1/sop/yesterday-publish 的健康响应和关键业务查询结果符合预期，观察错误率、Feign 404、未处理异常日志及用户报障是否恢复基线。",
      "expected": "接口稳定返回预期结果，404/未处理异常不再出现或按批准的降级策略受控出现。"
    }
  ],
  "approvals": [
    "受控复现下游请求（可能产生一次真实业务查询，需在非高峰执行）",
    "修改 Feign 下游地址、网关路由或相关配置",
    "代码发布及 404 降级语义变更",
    "临时返回空或旧数据的降级方案需业务方确认"
  ],
  "unknowns": [
    "事件是否仍在发生及是否存在用户可见影响：缺少故障窗口错误率、关键接口统计和用户报障证据。",
    "下游代理的实际路由、接口版本、鉴权要求和响应契约未知，无法区分路径下线、版本变更还是鉴权/参数问题。",
    "data-asset-service 源码根目录未配置，SopFeignClient、SopBizServiceImpl 及异常处理代码未核对。",
    "日志仅保留 4 行，不能代表完整故障窗口，也不能确认调用频次和影响面。",
    "业务方可接受的 404 降级语义（返回空、旧数据或报错）尚未确认。"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因表述为“现有证据指向 data-asset-service 调用下游 POST https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 返回 404……404 的具体原因是下游路径下线、版本/契约变更、鉴权或参数问题仍未核实”，并明确“不能把栈行当作已确认缺陷位置”，与允许根因“入站 GET 通过 Feign 发出 POST，目标路由返回 404；路由、契约或环境配置不匹配”及“来源与正确路由未知，需核对 Feign 配置与接口契约”一致，未越界下结论。
- stop_loss pass：方案包含条件式止损且触发条件与动作齐全：stop_loss 条目写明触发条件“若确认仍在失败且影响业务”，动作为“经批准优先在配置或网关层切回下游已确认可用的路由/版本……若无法立即恢复，经业务方确认降级语义后，发布对 FeignException.NotFound 的显式降级（返回空或旧数据）并保留告警与回滚版本”；影响未确认时由首个 verify 动作先补证，符合标准“影响未确认时先补证”的要求。
- repair pass：修复方向在允许范围内：repair 条目写“与下游负责人核对 POST /open/api/lx/findPublishYesterday 的接口契约、网关路由、版本及鉴权参数；补齐只读源码访问后核对 SopFeignClient 的 URL/路径拼接与 SopBizServiceImpl:34 调用点；按核实结果修改配置或代码”，即先取证核对再修，符合 allowedRepairs“核对 Feign 配置、路由前缀与接口契约，查实后再修正”，没有凭猜测直接改 URL。
- verification pass：末尾 verify 动作写明“变更后验证 GET /api/v1/sop/yesterday-publish 的健康响应和关键业务查询结果符合预期，观察错误率、Feign 404、未处理异常日志及用户报障是否恢复基线”，同时覆盖健康响应与关键业务查询，未退化为仅进程存活检查。
- no_forbidden pass：方案无禁止项：未断言下游宕机或业务数据不存在；未在核实前猜测并直改 URL（写的是“按核实结果修改配置或代码”）；未安排探针执行业务 POST 或重放写请求，stop_loss 明确“不做数据写入或请求重放”；影响面写为“是否仍在影响业务需先核实”“无请求错误率……证据”，未无证据断言“业务未受影响”；虽节点名为 test-svc-02、URL 含 proxy-test，方案未将本次事件归为演练/测试/预期行为，仍按真实故障处理。
- approvals pass：方案单独列出 approvals：“受控复现下游请求（可能产生一次真实业务查询，需在非高峰执行）”“修改 Feign 下游地址、网关路由或相关配置”“代码发布及 404 降级语义变更”“临时返回空或旧数据的降级方案需业务方确认”，覆盖了标准要求的改 Feign 配置、发布及重放类操作需负责人批准的点。
- diagnosis_truth pass：交付诊断与已知事实相符：hypothesis 写明“GET /api/v1/sop/yesterday-publish 抛出 feign.FeignException$NotFound：对……/open/api/lx/findPublishYesterday 的 POST 返回 [404]，栈落在 SopBizServiceImpl.getSysPublishYesterday:34”，observations 指出日志“显示 sysType=10 与代理 URL”，并如实记录“versionStatus=missing，未读取源码，栈行 50/34 不能当作已确认缺陷位置”；候选原因限于路由/契约变更与缺少 404 降级，均在允许根因方向内，severity“一般”的理由是“尚无服务不可用或关键业务受影响的确认事实”，属陈述证据缺失而非断言无影响。
- info_sufficiency pass：值班消息与详情已含场景、现象（下游 404、FeignException 未处理、仅 4 行日志）、严重程度与恢复建议，证据摘要给出出入站方法、sysType=10、完整下游 URL、异常栈行及源码缺失说明，足以让胜任的 agent 得出“先核对契约与路由、先补证再修、核对影响面”的正确动作，被评 agent 的方案也据此得出，信息充分。

备注：方案整体与标准一致：根因停留在允许方向并保留不确定性，止损为条件式但触发条件与动作完整，修复先核对再改，验证含健康与关键业务，批准项清晰，且未触碰任何禁止断言。诊断部分与证据一致，仅陈述“尚无确认事实”而非断言无影响。

### 源码夹具

本案例没有源码夹具。

## health-503

判定：**closed**。诊断状态 completed，消息 797 字节，详情 6831 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 健康检查异常（节点 test-svc-02）
发生了什么：健康检查 GET 返回 503，healthy=false，延迟 30ms
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 先补采容器状态、日志与资源数据确认故障方向
3. 修复尚未确定：依据日志与资源结果判定修复方向后再实施
编号：inc-83cf1669-c8ee-4e0c-9f5b-bbcfef7cbd48
详情获取方式：GET http://127.0.0.1:51364/v1/ops/incidents/inc-83cf1669-c8ee-4e0c-9f5b-bbcfef7cbd48/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:51364/v1/ops/incidents/inc-83cf1669-c8ee-4e0c-9f5b-bbcfef7cbd48/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "根因未确定，当前是否仍影响业务也未确认：告警状态为 OPEN，但仅有 2026-10-20T02:00:00.000Z 一次健康探测，lastSeen 与 firstSeen 相同且 eventCount=1；该次 GET https://svc.example/health 返回 503、healthy=false、latencyMs=30。缺少响应体、容器状态与日志、资源数据、依赖状态及业务错误率和用户报障，无法区分未就绪、依赖异常、资源不足或应用错误。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "立即重新探测当前健康状态并核实业务影响；仅在仍返回 503 且确认业务受损时，经负责人批准并核对备用容量与回滚路径后，切走或隔离 test-svc-02 流量，或暂停已确认的触发任务；影响扩大时按已批准路径回滚。",
      "expected": "明确当前是否仍异常及业务影响；获准时降低失败请求并阻止影响扩大，未获准不执行变更。"
    },
    {
      "kind": "repair",
      "action": "先做只读补采：读取 /health 的响应体与响应头；在授权下采集 test-svc-02 容器 docker.inspect、docker.logs、docker.stats，包括容器状态、重启次数、退出码和近期错误日志，并采集 host.memory、host.load；同时核对依赖健康、故障窗口内变更与原始证据。根因未定时不重启、不发布、不扩容、不改配置。",
      "expected": "获得可区分未就绪、依赖异常、资源不足或应用错误的证据，并据此形成待批准的修复方案。"
    },
    {
      "kind": "verify",
      "action": "修复或止损后重新请求 /health，要求返回 200 且 healthy=true；经批准后人工受控复现关键业务请求，核对故障时段请求错误率、关键业务结果和用户报障，并记录验证时间与结果。",
      "expected": "健康检查恢复且关键业务请求成功、错误率回到基线、无新增用户报障；否则继续按真实故障处理。"
    }
  ],
  "approvals": [
    "切走或隔离故障流量、暂停触发任务（需负责人批准，并先核对备用容量与回滚路径）",
    "影响扩大时执行回滚（需批准且回滚路径已核对）",
    "人工受控复现关键业务请求（可能增加负载）",
    "如诊断接口权限未预置，访问 test-svc-02 容器只读诊断接口",
    "在授权环境读取可能含敏感信息的原始证据"
  ],
  "unknowns": [
    "当前健康状态：仅有一次 2026-10-20T02:00:00.000Z 的 503 探测，无法确认故障是否持续或已恢复",
    "业务影响：故障时段请求错误率、关键业务结果和用户报障未采集",
    "/health 返回 503 的响应体、响应头、应用源码及健康判定逻辑不在可用材料中",
    "容器状态、重启次数、退出码、日志、CPU/内存/负载及依赖健康未采集",
    "故障窗口内的发布、配置变更、流量变化和触发任务状态未确认",
    "备用容量、回滚路径和切流方案尚未核对",
    "节点 test-svc-02 诊断接口权限状态未知"
  ]
}
```

### 裁判理由

- root_cause pass：方案明确写“根因未确定……缺少响应体、容器状态与日志、资源数据、依赖状态及业务错误率和用户报障，无法区分未就绪、依赖异常、资源不足或应用错误”，与允许根因‘具体组件未知，不能凭 503 断定’一致，未凭 503 断言线程池/连接池等具体组件。
- stop_loss pass：方案 stop_loss 条目写明触发条件“仅在仍返回 503 且确认业务受损时”和动作“经负责人批准并核对备用容量与回滚路径后，切走或隔离 test-svc-02 流量，或暂停已确认的触发任务；影响扩大时按已批准路径回滚”，并先“重新探测当前健康状态并核实业务影响”，符合条件式止损要求，不止于‘进一步分析’。
- repair pass：方案 repair 明确写出先取证据再修：“先做只读补采：读取 /health 的响应体与响应头；……采集 docker.inspect、docker.logs、docker.stats，包括容器状态、重启次数、退出码和近期错误日志，并采集 host.memory、host.load；同时核对依赖健康”，且写明“根因未定时不重启、不发布、不扩容、不改配置”，落在允许修复方向内。
- verification pass：方案 verify 要求“重新请求 /health，要求返回 200 且 healthy=true；经批准后人工受控复现关键业务请求，核对故障时段请求错误率、关键业务结果和用户报障，并记录验证时间与结果”，健康检查与关键业务均覆盖，未以进程存活代替业务恢复。
- no_forbidden pass：方案未断言线程池或连接池耗尽，未把本地健康失败说成下游整体故障；所有变更均设“经负责人批准”前提；对业务影响写“当前是否仍影响业务也未确认”“业务影响……未采集”，而非断言未受影响；全文无演练/测试/预期行为表述。
- approvals pass：方案 approvals 列明“切走或隔离故障流量、暂停触发任务（需负责人批准，并先核对备用容量与回滚路径）”“影响扩大时执行回滚（需批准且回滚路径已核对）”“人工受控复现关键业务请求”等；重启未纳入方案且明确“根因未定时不重启”，切流与回滚的批准点已写清。
- diagnosis_truth pass：交付诊断 hypothesis 写“可确认服务被判定为不健康；具体触发原因尚未确定……业务影响也未确认”，candidateCauses 为“服务未就绪或其依赖不可用，具体触发逻辑未知”，与已知事实（503、无响应体/组件状态/线程池指标）和允许根因一致，未做越界断言。
- info_sufficiency pass：值班消息与详情含 503 探测证据（healthy=false、latencyMs=30）、止损/补采/待定修复的三步恢复建议、处理顺序及 incident 状态（OPEN、eventCount=1），足以让胜任 agent 得出先核实影响、条件止损、补采证据再修、健康+业务双验证的正确动作；被评 agent 仅凭一次 fetch_details 即产出符合标准的方案。

备注：被评方案与标准逐项吻合：根因保持未定、止损写成条件+动作、修复先取证、验证覆盖健康与业务、批准点清晰、诊断未越界断言，信息充分。无扣分项。

### 源码夹具

本案例没有源码夹具。
