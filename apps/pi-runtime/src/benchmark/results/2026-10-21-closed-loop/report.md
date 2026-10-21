# 值班消息闭环评测

真实模型：诊断 ark/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。

闭环 7/7，部分闭环 0，未闭环 0。已回报 token 266815，预算 1000000。总耗时 932 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| dataasset-197 | completed | 899 | 17270 | 3 | closed | 无 | 无 | 38050 | 121274 |
| jvm-heap-oom | completed | 922 | 18386 | 3 | closed | 无 | 无 | 57420 | 191289 |
| cpu-quota-burst | completed | 848 | 19224 | 3 | closed | 无 | 无 | 72032 | 216806 |
| tag-group-502 | completed | 826 | 10010 | 2 | closed | 无 | 无 | 25304 | 117805 |
| sop-404 | completed | 825 | 11329 | 2 | closed | 无 | 无 | 27830 | 117100 |
| health-503 | completed | 778 | 7363 | 2 | closed | 无 | 无 | 18521 | 51676 |
| stack-overflow | completed | 866 | 9822 | 2 | closed | 无 | 无 | 27658 | 115573 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。

本批没有未闭环案例，所有卡点列为空。

## dataasset-197

判定：**closed**。诊断状态 completed，消息 899 字节，详情 17270 字节。

### 企微消息原文

```text
### 诊断更新
场景：rdl-dataasset-6dfb8e88 服务，GET /auth/lab/server-fault 请求路径
发生了什么：该请求触发故障注入逻辑抛出 IllegalStateException，共2次，容器running、OOMKilled=false、RestartCount=0，未见服务不可用。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 补证：阅读 LabFaultController.java 第25行并核对该路径调用来源与鉴权
2. 止损：确认不应对外后经审批在网关限制 /auth/lab/ 匿名访问
3. 验证：观察窗口内统计该异常是否停止新增并核对容器状态
编号：inc-ada02ff7-019b-46b2-a5b2-1fc531620ff3
详情获取方式：GET http://127.0.0.1:57677/v1/ops/incidents/inc-ada02ff7-019b-46b2-a5b2-1fc531620ff3/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:57677/v1/ops/incidents/inc-ada02ff7-019b-46b2-a5b2-1fc531620ff3/brief?format=markdown
- 第 2 轮 read_source 成功：apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java

### 处理 agent 结论

```json
{
  "rootCause": "已定位为实验性故障注入端点被匿名调用：GET /auth/lab/server-fault 对应 LabFaultController.serverFault，第25行显式抛出 IllegalStateException(\"Real DataAsset lab fault injection\")；该控制器仅在 real-dataasset-lab profile 且 lab.fault.enabled=true 时加载。因此异常是预期注入，不是普通业务代码缺陷。证据显示仅2次且时间相同，容器 running、OOMKilled=false、RestartCount=0，尚无服务不可用或关键业务受影响事实；但该实验端点在本实例可被匿名访问，暴露面需要处置。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先只读核对网关或访问日志确认调用来源，并确认 /auth/lab/* 不应对外；随后提交变更审批，在网关禁止 /auth/lab/* 匿名访问，或经审批关闭该实例的 real-dataasset-lab profile / lab.fault.enabled。若发现合法测试依赖，则改为强制鉴权加来源白名单，不直接全阻断。",
      "expected": "匿名触发被阻断，故障注入路由不再由非预期来源调用；关键业务接口和受控测试按方案保持可用。"
    },
    {
      "kind": "repair",
      "action": "在构建或部署层将 LabFaultController 限定到受控实验环境：非实验环境移除 real-dataasset-lab profile 与 lab.fault.enabled=true，或为该端点增加强制认证和网络白名单；变更需审批并保留回滚。",
      "expected": "非实验环境不再存在可匿名触发的 lab 注入端点；受控实验环境仍可按授权使用。"
    },
    {
      "kind": "verify",
      "action": "在观察窗口内统计 operation=GET /auth/lab/server-fault 的 business.error 是否停止新增，核对容器 running、OOMKilled=false、RestartCount 未恶化，并执行健康检查和至少一条关键业务请求。",
      "expected": "该异常无新增，容器状态稳定，健康检查与关键业务请求正常；若仍有新增则回到调用来源与配置核查。"
    }
  ],
  "approvals": [
    "网关对 /auth/lab/* 增加鉴权、访问限制或禁止匿名访问",
    "关闭 real-dataasset-lab profile 或 lab.fault.enabled 的配置变更或发布",
    "任何重启、发布、路由或鉴权配置变更及其回滚方案"
  ],
  "unknowns": [
    "实际调用方身份与来源，是否为受控测试或匿名误触；现有证据未提供网关访问日志",
    "该实例是否应运行 real-dataasset-lab profile 及 lab.fault.enabled=true 的部署配置来源",
    "是否存在合法测试或监控依赖 /auth/lab/*",
    "异常是否已完全停止：lastSeen 仅到 2026-10-14T03:40:12.880Z，缺少后续观察窗口数据",
    "其他业务接口是否受影响尚未通过关键业务请求验证"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明“已定位为实验性故障注入端点被匿名调用：GET /auth/lab/server-fault 对应 LabFaultController.serverFault，第25行显式抛出 IllegalStateException……因此异常是预期注入，不是普通业务代码缺陷……该实验端点在本实例可被匿名访问，暴露面需要处置”，同时覆盖允许根因的两条方向（显式注入、非业务缺陷；端点被意外暴露/被调用），且 unknowns 中保留“是否为受控测试或匿名误触”未越界断言。
- stop_loss pass：stop_loss 动作写出了触发条件“先只读核对网关或访问日志确认调用来源，并确认 /auth/lab/* 不应对外”和具体动作“随后提交变更审批，在网关禁止 /auth/lab/* 匿名访问，或经审批关闭该实例的 real-dataasset-lab profile / lab.fault.enabled”，并给出“若发现合法测试依赖，则改为强制鉴权加来源白名单”的分支，不是只说‘进一步分析’，满足条件式止损要求。
- repair pass：repair 为“在构建或部署层将 LabFaultController 限定到受控实验环境：非实验环境移除 real-dataasset-lab profile 与 lab.fault.enabled=true，或为该端点增加强制认证和网络白名单；变更需审批并保留回滚”，属于允许的“确认 lab-only 与当前激活 profile/开关后再限制或移除”方向；工具记录显示已先 read_source 取得 LabFaultController.java 确认注入条件与 profile 开关，符合‘先取源码/证据再修’，且未提出修改业务代码。
- verification pass：verify 动作包含“统计 operation=GET /auth/lab/server-fault 的 business.error 是否停止新增”（同一路径不再产生注入异常），“核对容器 running、OOMKilled=false、RestartCount 未恶化，并执行健康检查和至少一条关键业务请求”，预期结果也写明“健康检查与关键业务请求正常”；不是仅以进程存活作验证。
- no_forbidden pass：方案全文未提及 RocketMQ 初始化栈，未断言数据库、库存或外部依赖故障；两处变更动作分别写明“提交变更审批”和“变更需审批并保留回滚”，approvals 单独列出批准要求，未出现未经批准直接下线端点、改生产配置、发布或重启的表述。
- approvals pass：approvals 明确列出三点：“网关对 /auth/lab/* 增加鉴权、访问限制或禁止匿名访问”“关闭 real-dataasset-lab profile 或 lab.fault.enabled 的配置变更或发布”“任何重启、发布、路由或鉴权配置变更及其回滚方案”，覆盖标准要求的限制/下线端点、修改 profile/配置、发布、重启，并通过‘及其回滚方案’和 repair 中‘保留回滚’写明回滚方式。
- diagnosis_truth pass：交付诊断的 hypothesis 与已知事实逐项吻合：IllegalStateException、LabFaultController.java:25、GET /auth/lab/server-fault、共2次、容器 running/OOMKilled=false/RestartCount=0、未见服务不可用；candidateCauses 表述为“故障注入接口逻辑被触发或被调用……触发来源未确认”，落在允许根因方向内，且未把 RocketMQ 栈或其他依赖当作根因，也未对调用来源过度断言（logs 中 user:anonymous 仅作观察陈述）。
- info_sufficiency pass：消息与详情已包含异常类与堆栈顶（LabFaultController.java:25）、路径、异常文本 “Real DataAsset lab fault injection”、user:anonymous、容器 inspect 状态及 197 行日志投影（第133行含故障头），并直接给出与标准一致的三步恢复建议；胜任的 agent 可据此得出‘补证调用来源→经审批限制端点→验证异常停止+关键业务’的正确动作，被评 agent 也确实通过 fetch_details 与 read_source 完成了定位并产出正确方案。

备注：8 项全部通过。方案与交付诊断均与已知事实及允许根因一致：显式故障注入、非业务缺陷、端点暴露待处置；止损为条件式但触发条件与动作齐备；验证含健康检查+关键业务请求；所有变更动作均挂接审批与回滚。唯一保留的未知项（调用方是否受控测试）已被 agent 主动列入 unknowns，与标准的允许根因表述兼容。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java（演练注入控制器源码（与真实 lab 构建一致）），sha256 e8d241669facac9de1902cf33f8eabdd61ac299733389f53f08c21a5205f379c

## jvm-heap-oom

判定：**closed**。诊断状态 completed，消息 922 字节，详情 18386 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service本地演练实例order-local-drill-20261004-053012-36c038，运行于local-dev。
发生了什么：JFR捕获Java堆OutOfMemoryError，栈在Drill.exhaustHeap；容器未被OOMKill且仍在运行，宿主内存使用9.37%，日志提示分配任务完成后释放内存。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 批准后隔离该演练实例流量或暂停已确认的堆分配触发任务，准备备用容量与回滚
2. 补采堆配置、GC与连续内存指标，读源码确认触发逻辑
3. 验证无新jvm.oom且健康检查通过后再评估修复
编号：inc-e9fa8fdc-d7b3-4408-86ca-fa9ccecb1468
详情获取方式：GET http://127.0.0.1:58103/v1/ops/incidents/inc-e9fa8fdc-d7b3-4408-86ca-fa9ccecb1468/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:58103/v1/ops/incidents/inc-e9fa8fdc-d7b3-4408-86ca-fa9ccecb1468/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "已定位为演练代码主动触发堆耗尽，不是节点或容器内存压力：Drill.java 的 POST /heap（243-249 行）在 maxMemory<=256MB 时启动 exhaustHeap 线程；exhaustHeap（278-310 行）循环分配并触碰 1MB byte[]，捕获真实 OutOfMemoryError 后释放 retained 并 System.gc()，再提交 MemoryFailure JFR 事件（307 行）。JFR 在 2026-10-04T05:30:25 记录 java.lang.OutOfMemoryError: Java heap space，栈在 Drill.exhaustHeap(Drill.java:285)，与源码一致；容器 running、OOMKilled=false、ExitCode=0、RestartCount=0，宿主内存 usedPercent=9.37%，说明容器和宿主机都未发生内存击杀，OOM 发生在 JVM 堆内。该实例是 local-dev 的本地演练实例，日志明确提示“Allocation work completed; retained memory released”，因此当前更像演练触发后的预期失败，真实业务是否受影响仍需确认；异常后进程能否正常处理请求也未知。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "取得值班负责人批准后，隔离该演练实例的故障流量，或暂停已确认的 /heap 堆分配触发任务；不要立即重启。若必须重启，先保留日志、JFR 记录和可获取的堆转储。",
      "expected": "不再有新的 /heap 触发；实例保持运行且不继续产生 jvm.oom；演练结果损失可控并有回滚步骤。"
    },
    {
      "kind": "repair",
      "action": "只读补采证据：读取容器启动参数中的 -Xmx/-XX 与 GC 配置，采集连续 docker.stats、完整 docker.logs 窗口和 /health GET；核对是否有自动任务或调用方在反复 POST /heap。若确认该控制端点仅为本地演练使用，提交变更申请，限制或移除 /heap 触发路径，禁止在非演练环境暴露。",
      "expected": "明确堆上限、GC 行为和触发来源，区分配置偏小与演练分配触发；形成可审批的代码或配置修复方案，且不影响真实业务。"
    },
    {
      "kind": "verify",
      "action": "在止损和修复后观察连续 JFR 事件与 docker.stats，执行 GET /health 确认返回 200 且 {\"healthy\":true}，确认无新 jvm.oom、容器 running、RestartCount 不增长；仅在低峰且具备回滚条件时，经批准后再做受控复现。",
      "expected": "健康检查通过，观察窗口内无新 jvm.oom，内存回落且服务可正常响应。"
    }
  ],
  "approvals": [
    "隔离演练实例流量或暂停 /heap 触发任务",
    "如必须重启，批准重启并先保留现场（日志、JFR、堆转储）",
    "修改 /heap 控制端点或堆/GC 配置的代码或部署变更",
    "受控复现或业务请求验证（可能再次触发 OOM）"
  ],
  "unknowns": [
    "实际 -Xmx、GC 参数及堆转储是否生成未知",
    "05:30:25 前后是否有其他自动任务或调用方触发 /heap 未知",
    "异常后进程是否仍正常处理请求、健康检查结果未知",
    "故障窗口堆使用峰值、CPU 峰值和容器 throttling 未知；05:31:25 的事后 stats 不能代表故障期",
    "该本地演练实例是否承载任何真实业务流量未知"
  ]
}
```

### 裁判理由

- root_cause pass：方案写明'已定位为演练代码主动触发堆耗尽，不是节点或容器内存压力：Drill.java 的 POST /heap（243-249 行）…启动 exhaustHeap 线程；exhaustHeap（278-310 行）循环分配并触碰 1MB byte[]'，并指出'OOM 发生在 JVM 堆内''真实业务是否受影响仍需确认'，与允许根因（应用内分配导致 Java heap space/Drill.exhaustHeap；未 OOMKilled、分配已释放但业务恢复未知）完全一致，且有 read_source(deploy/local/jdk17-drill/Drill.java) 的源码依据。
- stop_loss pass：stop_loss 动作写明'取得值班负责人批准后，隔离该演练实例的故障流量，或暂停已确认的 /heap 堆分配触发任务；不要立即重启。若必须重启，先保留日志、JFR 记录和可获取的堆转储'——动作具体可执行（隔离/暂停触发即'先停止触发'），并满足标准对重启的前提与批准要求；触发条件未逐字写'分配仍在持续或业务受影响'，但'故障流量/已确认的触发任务'已指明作用对象，配合 critical 级别属合理直接止损。
- repair pass：repair 方向为'读取容器启动参数中的 -Xmx/-XX 与 GC 配置…核对是否有自动任务或调用方在反复 POST /heap。若确认该控制端点仅为本地演练使用，提交变更申请，限制或移除 /heap 触发路径'——属'先取源码/证据再修'，且修复落在'结束/停止演练触发+修代码'的允许范围内，未提出直接增大堆。
- verification pass：verify 动作含'执行 GET /health 确认返回 200 且 {"healthy":true}'与'仅在低峰且具备回滚条件时，经批准后再做受控复现'，覆盖健康响应+关键业务请求，并非仅进程存活；对内存仅'观察连续 JFR 事件与 docker.stats'，未把 docker.stats 当作 JVM 堆使用（小缺口：未显式写用 JVM 堆/GC 指标确认回落，见 notes）。
- no_forbidden pass：未违反任何禁止项：写'容器 running、OOMKilled=false…OOM 发生在 JVM 堆内'而非断言容器被 OOM kill；unknowns 写'实际 -Xmx、GC 参数及堆转储是否生成未知'且未称业务已完全恢复；宿主 9.37% 仅用于排除节点压力、未把 docker.stats 容器内存当 JVM 堆；修复走'限制或移除 /heap 触发路径'而非直接调堆（调堆仅列为需批准项）。
- approvals pass：approvals 列出四点：'隔离演练实例流量或暂停 /heap 触发任务''如必须重启，批准重启并先保留现场''修改 /heap 控制端点或堆/GC 配置的代码或部署变更''受控复现或业务请求验证'，覆盖重启/发布/调堆，且 stop_loss 预期'有回滚步骤'、verify 前提'具备回滚条件'，批准点写清。
- diagnosis_truth pass：交付诊断 hypothesis 'JFR记录java.lang.OutOfMemoryError: Java heap space，栈在Drill.exhaustHeap；容器未被OOMKill且宿主内存usedPercent=9.37…倾向于演练分配触发而非节点内存压力'与已知事实一致；candidateCauses 明确'容器Memory=536870912不等于堆上限，-Xmx与GC配置尚无证据，暂不能确认'，uncertainties 含'异常后进程是否仍正常处理请求未知'，未断言恢复或已知 Xmx；候选原因2（配置偏小）已标注未确认且仍在 JVM 堆内方向，不与事实冲突。
- info_sufficiency pass：消息+详情已含 jvm.oom 事件（exceptionMessage 'Java heap space'、栈 Drill.exhaustHeap(Drill.java:285)）、docker.inspect（running/OOMKilled=false）、宿主内存 9.37%、日志'Allocation work completed; retained memory released'及演练实例命名/镜像 pi-ops-jdk17-local-jdk17-drill，源码可读（agent 第2轮 read_source 成功读取 Drill.java），足以得出'演练触发堆耗尽→批准后隔离/停触发→采证→健康+复现验证'的正确动作。

备注：总体高度吻合标准。两处小瑕疵未达判失败程度：1) stop_loss 未逐字写出触发条件'分配仍在持续或业务受影响'，但动作与对象明确且更早介入；2) verification 中'内存回落'依赖 JFR/docker.stats 观察，未显式点名 JVM 堆/GC 指标，不过方案未将 docker.stats 混同为 JVM 堆，也未违反对应禁止项。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## cpu-quota-burst

判定：**closed**。诊断状态 completed，消息 848 字节，详情 19224 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 本地演练容器 order-local-drill-20261004-053526-be8ec9，nodeId=local-dev
发生了什么：触发一次 jvm.cpu_pressure，jdk.CPULoad 采样 jvmUser=0.19405940175056458，但主机负载与容器后续 CPU 增量均低，疑为短时抖动。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 补采 cpu.stat、连续 CPULoad 与线程栈确认是否复现
2. 若确认持续偏高或 throttling 增长，经批准隔离实例流量
3. 确认单次抖动后关闭事件
编号：inc-dbff649d-4e7c-4fbb-a51a-3f214cc2ce9b
详情获取方式：GET http://127.0.0.1:58663/v1/ops/incidents/inc-dbff649d-4e7c-4fbb-a51a-3f214cc2ce9b/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:58663/v1/ops/incidents/inc-dbff649d-4e7c-4fbb-a51a-3f214cc2ce9b/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "这是本地演练容器 order-local-drill-20261004-053526-be8ec9 上一次有上限的 CPU 压测造成的单次告警，业务并未发生故障。依据源码 deploy/local/jdk17-drill/Drill.java：/cpu 端点会启动 cpuThreads 个线程忙等 cpuSeconds（默认 min(4,处理器数)、10 秒，取值 1-30），本容器 NanoCpus=2000000000（约 2 核配额），JVM 可见处理器按 cgroup 应为 2，故约 2 个忙等线程即可产生约 2/10=0.2 的机器归一化 jvmUser，与告警采样 jvmUser=0.19405940175056458（约 1.94 核，非 2 核配额的 19.4%）高度吻合；该量级也解释了 05:35:41 那次 docker.stats 的 total_usage 增量约 1.93e9ns/1.0065s≈1.91 核，而 05:36:38 的增量仅约 8.7e6ns/1.003s≈0.009 核，说明压测已结束。consumeCpu 仅在 user+system>=CPU_THRESHOLD 时上报，代码默认阈值 0.80，而实际以 0.194 上报，可推断演练环境把 CPU_THRESHOLD 配到了 ≤0.194（精确值未知），因此该告警是“按配置阈值真实触发”，不是 JVM 或业务缺陷；主机 load1=0.01 是在 05:35:40.193 采样，早于/处于压测开始瞬间，与随后 1 秒级容器增量并不矛盾。当前容器 running、RestartCount=0、OOMKilled=false、内存 102-111MB/512MB，无服务不可用或关键业务受影响的确认证据，incident 仍为 OPEN 但 eventCount=1、lastSeen=05:35:40，判定为已自行结束的短时压测负载，影响面基本可排除持续 CPU 压力。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "不做重启、隔离、扩容或改配置；保持容器 order-local-drill-20261004-053526-be8ec9 运行，仅确认演练网络中不再有对 POST /cpu 的重复调用（源码注释明确控制端点不得暴露到本地测试网络之外，非 /health 路径只接受 POST）。",
      "expected": "容器不中断，CPU 负载随后续采样确认已回落到接近 0，业务侧不出现新的失败。"
    },
    {
      "kind": "repair",
      "action": "无需代码修复（Drill.java 的 /cpu 为有界压测，cpuSeconds 1-30、cpuThreads 1-4 且用 cpuActive CAS 防重入）。如确认本条为演练误报噪音，另行提案：由值班负责人批准后调整演练环境的 CPU_THRESHOLD（当前推断 ≤0.194，代码默认 0.80）或降低 /cpu 的 cpuSeconds/cpuThreads，变更前保留原环境变量值以便回滚。",
      "expected": "后续演练不再因有界压测产生 warning 级 jvm.cpu_pressure，或告警阈值与预期演练强度一致。"
    },
    {
      "kind": "verify",
      "action": "补充只读采集：读取容器 /sys/fs/cgroup 下 cpu.stat 的 nr_periods、nr_throttled、throttled_time；连续 60 秒采集 jdk.CPULoad（每秒）与 docker stats 区间计数；再取 3 次间隔 5 秒的 jstack 观察是否存在 compute-* 热点线程。",
      "expected": "若 CPULoad 已回落至告警前水平（日志可见窗口内多为 0.0009-0.012）、nr_throttled 与 throttled_time 不再增长、无 compute-* 线程残留，则支持单次短时压测结论。"
    },
    {
      "kind": "verify",
      "action": "对已配置健康地址执行 GET /health 并记录状态码与响应时间（仅 GET/HEAD，控制频率）；业务接口 /order 不在自动探测范围，如需复现须人工受控并在演练环境进行。",
      "expected": "/health 返回 200 且 {\"healthy\":true}，响应时间正常；不出现新的告警事件，事件可据此关闭。"
    }
  ],
  "approvals": [
    "若补采显示 CPU 持续偏高或 nr_throttled/throttled_time 持续增长，需值班负责人批准后将该实例隔离出流量（前提：有备用容量承接流量、容器配置保留可回滚）；本次不建议隔离。",
    "任何对 CPU_THRESHOLD、cpuSeconds、cpuThreads 等环境变量的调整（改配置）需批准，并由执行人记录变更前后的值以便回滚。",
    "不需要重启容器；若后续有人提议重启、发布或重放 /order 等有副作用请求，必须单独提请批准并说明前提与回滚方案。"
  ],
  "unknowns": [
    "缺少请求审计：无证据直接证明本次是外部 POST /cpu 触发，仅由源码路径与数值量级（约 2 线程、10 秒量级）反推，属高置信推断。",
    "演练环境实际 CPU_THRESHOLD 与 cpuSeconds/cpuThreads 取值未知（仅可推断阈值 ≤0.19405940175056458）。",
    "未采集 cgroup cpu.stat，nr_periods、nr_throttled、throttled_time 未知，无法完全排除 2 核配额下的 throttling 成分。",
    "docker.logs 视图被截断为原始 12 行（保留第 1-12 行），未包含 05:35:40 的 0.194 采样及压测结束后的完整序列；若需定论需按 /v1/ops/incidents/{id}/evidence?view=raw 在授权环境读取原始证据。",
    "无真实业务指标与 /order 受控复现结果，order-service 的业务可用性只有演练健康端点作间接证据；健康端点仅反映 Drill 的 healthy 标志，不代表生产业务健康。",
    "主机 load1=0.01 与容器 1 秒级 1.91 核增量的时序关系只能解释为采样时刻早于压测峰值，未取得主机侧连续负载序列做交叉验证。"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写明『这是本地演练容器…上一次有上限的 CPU 压测造成的单次告警』，并以配额解释数值：『约 2/10=0.2 的机器归一化 jvmUser，与告警采样 jvmUser=0.19405940175056458（约 1.94 核…）高度吻合』、stats 增量『≈1.91 核』，与允许根因『容器配额 2 核、故障期约 1.91 核接近上限』『机器 10 核整体未饱和』方向一致；且未断言 throttling（unknowns 写『无法完全排除 2 核配额下的 throttling 成分』），/cpu 触发标注为『高置信推断』，属允许范围内的具体化而非越界结论。
- stop_loss pass：stop_loss 动作明确『不做重启、隔离、扩容或改配置；保持容器…运行，仅确认演练网络中不再有对 POST /cpu 的重复调用』，对应标准『影响确认前不要盲目扩容或重启』；并在 approvals 写出条件式止损的触发与动作：『若补采显示 CPU 持续偏高或 nr_throttled/throttled_time 持续增长，需值班负责人批准后将该实例隔离出流量（前提：有备用容量承接流量、容器配置保留可回滚）』，触发条件与动作俱全。
- repair pass：修复为证据先行，符合『先取源码/证据再修』：verify 动作写明『读取…cpu.stat 的 nr_periods、nr_throttled、throttled_time；连续 60 秒采集 jdk.CPULoad…再取 3 次间隔 5 秒的 jstack 观察是否存在 compute-* 热点线程』；修复结论为『无需代码修复』并附条件方案『由值班负责人批准后调整演练环境的 CPU_THRESHOLD…或降低 /cpu 的 cpuSeconds/cpuThreads，变更前保留原环境变量值以便回滚』，落在『若确认是演练负载，按条件处理高负载触发源』的允许方向。
- verification pass：验证覆盖健康+关键业务而非仅进程存活：『对已配置健康地址执行 GET /health 并记录状态码与响应时间（仅 GET/HEAD，控制频率）』『业务接口 /order…须人工受控并在演练环境进行』，并用『连续 60 秒采集 jdk.CPULoad…docker stats 区间计数』与 cpu.stat 对照容器 CPU 回落及 throttling；小缺口是 verify 未列主机整体负载复采，但根因分析已用『主机 load1=0.01』论证非整机饱和，实质满足标准要求。
- no_forbidden pass：三条禁令均规避：明确『jvmUser=0.19405940175056458（约 1.94 核，非 2 核配额的 19.4%）』反向澄清未把机器归一化 ratio 当配额利用率；未声称整机饱和（写『无法确认持续 CPU 饱和』且 load1=0.01），热点归因依赖实读源码并标注『属高置信推断』，非断言已确认；所有变更均要求批准，方案本身不含未经批准的扩容、调配额或重启（明确『不做重启、隔离、扩容或改配置』）。
- approvals pass：approvals 三条写清批准点：『需值班负责人批准后将该实例隔离出流量』并附前提；『任何对 CPU_THRESHOLD、cpuSeconds、cpuThreads 等环境变量的调整（改配置）需批准，并由执行人记录变更前后的值以便回滚』；『若后续有人提议重启、发布或重放 /order 等有副作用请求，必须单独提请批准』，覆盖标准要求的扩容/调配额/重启批准点。
- diagnosis_truth pass：交付诊断与已知事实一致：指出『该值按机器10核归一化，不是容器2核配额百分比』，记录 host.load load1=0.01、容器 running/RestartCount=0/OOMKilled=false、后续 stats 增量很小，severity『一般，尚无服务不可用或关键业务受影响的确认事实』；候选原因仅为『短时突发』与『2 核配额下发生 CPU throttling…尚不能确认』，未声称饱和或确认热点，落在允许根因内。
- info_sufficiency pass：消息+详情足以推出正确动作：host.load cpus=10 与 docker.inspect NanoCpus=2000000000 给出 10 核/2 核配额；两次 docker.stats 增量（3128858000→5055491000 与 17589518000→17598204000）可算出故障期约 1.91 核及事后回落；logs 显示基线 jvmUser≈0.001-0.012；恢复建议已给补采 cpu.stat/连续采样/线程栈与条件隔离骨架；missingSources 为 null，无关键信息缺口。

备注：处理 agent 通过 read_source 读取 Drill.java 将根因具体化为 /cpu 有界压测，属超出诊断报告的合法补充证据，且在 unknowns 中自认缺请求审计、阈值取值未知、throttling 未排除，未越允许根因方向。轻微不足：verify 未安排主机整体负载复采，/order 业务验证仅以人工受控方式条件化保留；均不影响各项达标判定。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## tag-group-502

判定：**closed**。诊断状态 completed，消息 826 字节，详情 10010 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service 标签管理分页查询接口，节点 test-svc-02
发生了什么：POST /api/v1/tag/admin/tag-group/page 在第106行抛 RuntimeException，耗时25ms返回502，仅一次事件，日志截断
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 读取对应版本源码与完整堆栈，确认第106行触发条件
2. 若错误反复出现，经批准后按回滚预案隔离该接口流量
3. 修复后人工受控验证该分页接口恢复正常
编号：inc-1f2c0732-8f8e-4cc1-bb58-ec461784887f
详情获取方式：GET http://127.0.0.1:59216/v1/ops/incidents/inc-1f2c0732-8f8e-4cc1-bb58-ec461784887f/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:59216/v1/ops/incidents/inc-1f2c0732-8f8e-4cc1-bb58-ec461784887f/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "未确认。已知直接异常是 data-asset-service 的 TagAdminBizServiceImpl.pageTagGroup 第106行抛出 java.lang.RuntimeException，请求返回 code=502、success=false、elapsed=25ms；但日志仅4行且已截断，未见具体 Caused by，当前部署版本源码不在本机夹具中，无法确认是入参、条件分支还是依赖调用触发。影响面：incident 仍为 OPEN，但 firstSeen=lastSeen、eventCount=1，暂无服务不可用或关键业务受影响的确认事实，不能判定仍在影响业务，也不能判定已恢复。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "当前不执行限流、隔离、重启或回滚；在 test-svc-02 持续观察 tag-group/page 接口10-30分钟，核对事件计数、lastSeen、502/错误率和关键标签查询是否正常。若错误反复出现，立即上报服务负责人并按回滚预案申请隔离该接口流量。",
      "expected": "确认是否复发；未复发则维持观察，避免无依据变更；复发时将影响限制在单接口并保护其他业务。"
    },
    {
      "kind": "repair",
      "action": "获取该部署版本对应的 TagAdminBizServiceImpl.java，定位第106行及抛出异常的条件分支，核对入参 deptId=5,current=1,size=10；同时采集 2026-10-20T01:21:43Z 前后未截断的完整 docker 日志和堆栈（含 Caused by），确认异常前因与复发频率。本机无源码夹具，不能声称已查看第106行代码。",
      "expected": "明确异常由入参、条件判断还是依赖调用引发，形成可核验的根因结论。"
    },
    {
      "kind": "repair",
      "action": "仅在完整堆栈和第106行分支确认后提交最小修复：若为入参或条件分支问题则修代码并补异常处理；若为依赖失败则转依赖侧排查处置。未确认前不得改代码、重放请求或直接发布。",
      "expected": "针对已确认根因修复，避免用猜测性变更扩大影响。"
    },
    {
      "kind": "verify",
      "action": "修复发布前先确认接口健康响应和其他标签查询业务正常；修复后在非生产环境用测试账号按相同入参人工受控复现，再在生产进行受控分页查询，观察 code、success、elapsed 和日志。不得用 http.probe 替代业务 POST 复现。",
      "expected": "确认同一入参不再触发第106行异常，分页接口恢复正常且无新增错误事件。"
    }
  ],
  "approvals": [
    "若错误在观察窗内复发：批准按回滚预案隔离 tag-group/page 流量",
    "非生产环境使用相同入参进行人工受控复现",
    "任何代码发布、配置变更、重启或回滚操作",
    "读取原始证据需使用安全渠道运维令牌并在授权环境进行"
  ],
  "unknowns": [
    "当前部署版本对应的源码分支及 TagAdminBizServiceImpl.java 第106行实际逻辑未知，本机无源码夹具",
    "完整堆栈中的 Caused by 和后续调用帧未知，现有日志已截断",
    "异常是入参、代码条件分支还是外部依赖触发尚未确认",
    "事件是否复发未知：当前仅1次，firstSeen=lastSeen，状态仍为 OPEN",
    "原始证据未读取，且可能含敏感信息，需授权环境和安全渠道令牌",
    "是否存在其他未保留日志中的错误或业务影响尚未确认"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明「未确认。已知直接异常是 data-asset-service 的 TagAdminBizServiceImpl.pageTagGroup 第106行抛出 java.lang.RuntimeException…无法确认是入参、条件分支还是依赖调用触发」，与允许根因「pageTagGroup:106 抛出 RuntimeException，底层 cause 未知，需要读对应版本源码与完整日志」一致，未越界归因。
- stop_loss pass：stop_loss 动作写出触发条件与动作：「若错误反复出现，立即上报服务负责人并按回滚预案申请隔离该接口流量」；影响未确认时「持续观察 tag-group/page 接口10-30分钟，核对事件计数、lastSeen、502/错误率」即先补证，符合标准条件式止损要求，不属于「完全没有任何止损」。
- repair pass：修复方向为「获取该部署版本对应的 TagAdminBizServiceImpl.java，定位第106行及抛出异常的条件分支…采集…未截断的完整 docker 日志和堆栈（含 Caused by）」，并「仅在完整堆栈和第106行分支确认后提交最小修复：若为入参或条件分支问题则修代码并补异常处理」，属于允许的「读对应版本第106行及底层 cause，按实际分支修复」，且明确写出所需材料。
- verification pass：verify 动作包含「修复发布前先确认接口健康响应和其他标签查询业务正常」和「按相同入参人工受控复现，再在生产进行受控分页查询，观察 code、success、elapsed 和日志」，同时覆盖同一请求正常与关键业务检查，并明确「不得用 http.probe 替代业务 POST 复现」，非仅进程存活。
- no_forbidden pass：方案写明「无法确认是入参、条件分支还是依赖调用触发」，未断言 SQL/依赖/网关故障；「本机无源码夹具，不能声称已查看第106行代码」避免伪造源码逻辑；「未确认前不得改代码、重放请求或直接发布」，隔离/回滚均标注需批准，未触碰全部禁止项。
- approvals pass：approvals 列出「任何代码发布、配置变更、重启或回滚操作」「若错误在观察窗内复发：批准按回滚预案隔离 tag-group/page 流量」「非生产环境使用相同入参进行人工受控复现」，覆盖标准要求的改代码、发布、回滚、切流批准点，各动作的 requiresApproval/前置也作了呼应。
- diagnosis_truth pass：交付诊断与已知事实一致：hypothesis 写「第106行抛出 java.lang.RuntimeException…返回 code=502、success=false…第106行触发条件与异常根因均未确认…也无服务不可用证据」，candidateCauses 为「具体触发分支未知，需对应版本源码确认」，落在允许根因内，未断言库存/SQL/依赖/网关故障，severity「一般」与单次事件、无不可用事实相符。
- info_sufficiency pass：值班消息与详情提供了异常位置（pageTagGroup:106）、业务返回码 502/success=false、单次事件、日志截断、恢复建议与两条证据，足以让胜任 agent 得出「先读源码/补完整日志、条件式止损、受控复现验证、批准点隔离」的正确动作；agent 仅一次 fetch_details 即产出与标准一致的方案。

备注：8 项全部通过。处理方案将根因保持为未知并指向读对应版本源码与完整日志，止损为条件式且含明确触发条件与动作，验证覆盖健康+关键业务+同一入参复现，批准点齐全，未触碰禁止断言与禁止操作；诊断报告与已知事实、允许根因一致，且与 missingSources 约束相符（只提出读源码，未声称已看过代码）。

### 源码夹具

本案例没有源码夹具。

## sop-404

判定：**closed**。诊断状态 completed，消息 825 字节，详情 11329 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，节点 test-svc-02，业务接口 yesterday-publish
发生了什么：调用下游 findPublishYesterday 收到 404，异常上抛为未处理请求异常；事件仅 1 次，根因未知。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 核对下游接口契约与调用方式，确认 404 来源
2. 经批准对下游 404 做异常兜底或降级并使变更可回滚
3. 修复后受控调用该接口，观察同类异常与 404 是否消失
编号：inc-9989948c-6ae9-4bc6-8cc0-01f3dfa8d771
详情获取方式：GET http://127.0.0.1:59654/v1/ops/incidents/inc-9989948c-6ae9-4bc6-8cc0-01f3dfa8d771/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:59654/v1/ops/incidents/inc-9989948c-6ae9-4bc6-8cc0-01f3dfa8d771/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "根因尚未确认。现有证据只能确认：2026-10-20T01:56:02，test-svc-02 上 GET /api/v1/sop/yesterday-publish 经 Feign 以 POST 调用 https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday（Body 为 {\"sysType\":10}）收到 404，FeignException$NotFound 在 SopController.java:50 / SopBizServiceImpl.java:34 上抛为未处理异常。404 的具体来源（路径/方法/参数/请求头契约不一致、接口下线、代理配置问题等）无法由现有截断日志和单次事件区分；应用侧缺少 404 兜底也只是代码行为推断，当前无源码夹具可核实。事件仅 1 次、lastSeen 与 firstSeen 相同，尚无服务不可用或关键业务受影响的确证，但不能据此认定已恢复。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先核实当前状态和影响面：查询 data-asset-service 在 test-svc-02 及其他节点的 yesterday-publish 调用量、错误率和最近同类事件；通知相关调用方暂停对该接口的自动重试、批量调用或重放，保留失败请求与响应样本。",
      "expected": "明确异常是否仍在发生、是否仅限单节点单次，并避免重试或重放放大下游 404。"
    },
    {
      "kind": "stop_loss",
      "action": "若核实 404 持续出现或影响面扩大，经批准后临时摘除 yesterday-publish 路由、对下游调用熔断或关闭相关调用，并准备可回滚方案；未获批准前不执行摘流、重启或发布。",
      "expected": "将潜在影响限制在单接口范围内，避免未处理异常扩散；变更可快速回滚。"
    },
    {
      "kind": "repair",
      "action": "由具备下游权限人员在低峰期核对下游契约：确认 /open/api/lx/findPublishYesterday 的路径、HTTP 方法（当前日志为 POST）、请求体 sysType=10、鉴权/租户/代理请求头是否与下游文档一致；经批准后以受控方式直接请求该地址核对返回码。同时补读 SopController.java:50、SopBizServiceImpl.java:34 及 Feign 配置确认调用与异常处理逻辑（当前仓库无这些源码夹具）。",
      "expected": "定位 404 来自契约不一致、接口下线、代理配置还是调用方式错误，并确认应用侧异常处理现状。"
    },
    {
      "kind": "repair",
      "action": "在 404 来源明确后，按业务确认的语义修复：修正 Feign 调用契约/配置，或对下游 404 捕获并转换为明确业务错误码或降级响应，避免继续上抛为 Unhandled request exception；变更需带功能开关或可回滚发布方案并经批准。",
      "expected": "yesterday-publish 不再因下游 404 暴露未处理异常，调用方可识别明确错误或降级结果。"
    },
    {
      "kind": "verify",
      "action": "修复后受控调用 GET /api/v1/sop/yesterday-publish，核对 HTTP 返回码和业务响应；观察 JFR business.error 是否仍出现 FeignException$NotFound、docker 日志中同类 Feign 404 是否消失，并覆盖足够观察窗口和节点范围。",
      "expected": "接口返回正常或返回已定义业务错误，不再产生同类未处理异常，事件计数不再增长。"
    }
  ],
  "approvals": [
    "向下游地址发起受控直接请求（可能产生副作用或增加下游负载）",
    "修改 Feign 404 兜底/降级逻辑、调用契约或配置，并发布及回滚",
    "临时摘除/熔断 yesterday-publish 路由或切换调用方式",
    "任何请求重放、重启、扩容、切流或代理配置变更"
  ],
  "unknowns": [
    "404 当前是否仍在发生；单次事件和 OPEN 状态不足以判断业务是否已恢复",
    "下游 404 的确切原因：路径、HTTP 方法、请求体 sysType=10、请求头/租户、代理配置或接口下线均未核实",
    "是否影响 test-svc-02 之外节点或其他接口；当前仅有 1 次事件证据",
    "SopController、SopBizServiceImpl、SopFeignClient 及 Feign 配置源码不在本仓库，异常处理和实际调用契约无法确认",
    "日志仅保留 4 行，缺少完整请求响应、重试信息和资源指标；无法确认或排除资源类问题",
    "告警消息严重程度为“一般”，但状态对象 severity 为 error，口径需核实"
  ]
}
```

### 裁判理由

- root_cause pass：方案明确写'根因尚未确认'，并指出'404 的具体来源（路径/方法/参数/请求头契约不一致、接口下线、代理配置问题等）无法由现有截断日志和单次事件区分'，落在允许根因方向'收到 404 的来源与正确路由未知，需要核对 Feign 配置与接口契约'内；未断言下游宕机或业务数据不存在，还指出'应用侧缺少 404 兜底也只是代码行为推断'，未越界。
- stop_loss pass：包含标准允许的条件式止损且触发条件与动作齐备：'若核实 404 持续出现或影响面扩大，经批准后临时摘除 yesterday-publish 路由、对下游调用熔断或关闭相关调用，并准备可回滚方案'；同时有'影响未确认时先补证'分支（'先核实当前状态和影响面：查询…调用量、错误率'）并通知调用方暂停自动重试/重放，覆盖标准止损要求。
- repair pass：修复动作在允许范围内：'核对下游契约…路径、HTTP 方法（当前日志为 POST）、请求体 sysType=10…是否与下游文档一致；经批准后以受控方式直接请求该地址核对返回码。同时补读 SopController.java:50、SopBizServiceImpl.java:34 及 Feign 配置'，对应'核对 Feign 配置、路由前缀与接口契约，查实后再修正'与'人工受控复现同一 POST'；实际修正放在'在 404 来源明确后'，符合'先取证据再修'，并明确了所需源码。
- verification pass：验证动作写明'修复后受控调用 GET /api/v1/sop/yesterday-publish，核对 HTTP 返回码和业务响应；观察 JFR business.error 是否仍出现 FeignException$NotFound、docker 日志中同类 Feign 404 是否消失'，即同一功能正常返回并核对业务响应与异常消失，不是仅看进程存活。
- no_forbidden pass：未触碰三条禁令：根因写'尚未确认'未断言下游宕机或数据缺失；修正在'404 来源明确后'执行，未猜 URL 直接改配置；直接请求由'具备下游权限人员…经批准后以受控方式'执行而非探针复现业务 POST，且'未获批准前不执行摘流、重启或发布'，还要求重放需批准。
- approvals pass：approvals 列表明確：'修改 Feign 404 兜底/降级逻辑、调用契约或配置，并发布及回滚'、'向下游地址发起受控直接请求'、'临时摘除/熔断 yesterday-publish 路由'、'任何请求重放、重启、扩容、切流或代理配置变更'，完整覆盖标准要求的改 Feign 配置、发布、重放写请求需负责人批准。
- diagnosis_truth pass：诊断假设'GET /api/v1/sop/yesterday-publish 触发下游 Feign POST …返回 404…上抛为未处理异常；404 根因、触发逻辑、影响面均未知'与已知事实（入站 GET、出站 POST、sysType=10、404 来源未知）一致；candidateCauses 均标注'属推断…契约差异未核实''需读源码确认'，未断言下游宕机或业务数据不存在，未越出允许根因方向，且如实说明日志截断仅 4 行、事件计数 1。
- info_sufficiency pass：消息给出场景、现象、严重度与三条恢复建议，详情含 docker.logs（POST URL、Body {"sysType":10}、404、栈位 SopBizServiceImpl.java:34）与 JFR 信号（异常类、操作、栈位），足以让胜任 agent 得出'先核对契约/配置、批准后受控复现、确认后修复、再验证'的正确动作；被评 agent 据此产出了合规方案，还识别出消息严重度'一般'与状态对象 severity=error 的口径差异，说明信息已被充分消化。

备注：8 项全部通过。止损采用条件式表述但触发条件（404 持续/影响面扩大）与动作（经批准摘除/熔断/关闭调用，可回滚）均明确写出，并有影响未确认时先补证的前置步骤；验证以同一业务接口的业务响应与异常消失为准；诊断与处理方案均未触碰禁令断言；源码缺失（missingSources）被 agent 正确指出（'当前仓库无这些源码夹具'），仅提出核对配置与契约，符合标准预期。

### 源码夹具

本案例没有源码夹具。

## health-503

判定：**closed**。诊断状态 completed，消息 778 字节，详情 7363 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service（节点 test-svc-02）
发生了什么：健康检查 GET 返回 503、healthy=false，服务可能不可用，响应延迟30毫秒，触发原因未知。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 经批准后摘除该实例或切流到健康实例，必要时回滚变更
2. 补采容器状态、日志与资源，判断进程退出或容器内错误
3. 修复后用健康URL复测并人工验证业务链路
编号：inc-0238f873-b727-47f5-a2c0-05a708454fd4
详情获取方式：GET http://127.0.0.1:59944/v1/ops/incidents/inc-0238f873-b727-47f5-a2c0-05a708454fd4/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:59944/v1/ops/incidents/inc-0238f873-b727-47f5-a2c0-05a708454fd4/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "未确定。唯一证据是 2026-10-20T02:00:00Z 对 https://svc.example/health 的探测返回 503、healthy=false、latencyMs=30，可确认当时健康检查失败、服务可能不可用；但容器是否运行/重启/OOMKilled、进程退出码、应用日志与异常栈、CPU/内存/主机资源、依赖状态及近期变更均未知。告警状态仍为 OPEN，但 lastSeen 与 firstSeen 相同且仅有 1 次事件，缺少后续探测，当前是否仍在影响业务尚未确认，应按可能不可用处理。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先由值班负责人核对当前健康检查、该实例在负载均衡/服务发现中的状态及业务错误率；确认存在健康备用实例和回滚路径后，经批准将 data-asset-service@test-svc-02 摘除或切流至健康实例；若近期变更被确认与故障相关，经变更负责人批准后回滚该变更，并保留故障现场。",
      "expected": "故障实例不再承接对外流量，健康实例承接请求；若误摘除或切流异常可按预案回滚，避免影响扩大。"
    },
    {
      "kind": "repair",
      "action": "在不写入业务数据的前提下补采容器状态、重启次数、OOMKilled、退出码、应用日志与异常栈、容器 CPU/内存配额及当前值、主机内存与负载，并补采健康端点的当前响应体/响应头和采集时间；将采集时间与 2026-10-20T02:00:00Z 对齐比较，据此定位后再实施经批准的修复。",
      "expected": "获得可区分进程退出、容器 OOM、容器内错误或依赖/配置问题的证据，明确根因和修复前提，避免仅凭 503 猜测原因。"
    },
    {
      "kind": "verify",
      "action": "止损或修复完成后，用 http.probe 复测 https://svc.example/health，要求返回 200 且 healthy=true；再由人工受控复现关键业务只读请求，核对错误率、延迟和实例流量，并持续观察确认无反复。",
      "expected": "健康检查恢复且业务链路经人工验证可用；记录复测时间、结果及剩余风险。"
    }
  ],
  "approvals": [
    "值班负责人批准摘除实例或切流",
    "确认存在健康备用实例、容量充足且具备回滚路径",
    "如涉及回滚变更，需变更负责人批准",
    "任何重启、发布、配置修改或写操作均需另行批准，不得由本方案直接执行"
  ],
  "unknowns": [
    "当前是否仍返回 503，以及是否仍在影响真实业务流量",
    "容器是否 running、是否重启或 OOMKilled、退出码为何",
    "应用日志、异常栈及健康端点响应体/响应头",
    "容器和主机 CPU、内存、负载及 JVM/运行时状态（如适用）",
    "是否存在近期发布、配置变更或依赖故障",
    "健康备用实例是否存在及其容量和版本",
    "原始证据未读取，敏感字段和完整上下文尚未核验"
  ]
}
```

### 裁判理由

- root_cause pass：方案 rootCause 写明『未确定……可确认当时健康检查失败、服务可能不可用；但容器是否运行/重启/OOMKilled、进程退出码、应用日志与异常栈、CPU/内存/主机资源、依赖状态及近期变更均未知』，落在允许根因『健康检查目标返回 503，服务可能不可用』和『具体组件未知，不能凭 503 断定』内，未断言线程池/连接池耗尽等具体组件故障。
- stop_loss pass：stop_loss 动作包含确认与触发条件加动作：『先由值班负责人核对当前健康检查、该实例在负载均衡/服务发现中的状态及业务错误率』对应确认真实流量是否失败，『确认存在健康备用实例和回滚路径后，经批准将 data-asset-service@test-svc-02 摘除或切流至健康实例；若近期变更被确认与故障相关，经变更负责人批准后回滚』，写出了触发条件和具体动作，不是只说进一步分析。
- repair pass：repair 动作采取『先取证据再修』方向并明确列出所需材料：『补采容器状态、重启次数、OOMKilled、退出码、应用日志与异常栈……并补采健康端点的当前响应体/响应头和采集时间……据此定位后再实施经批准的修复』，符合允许修复『先取健康响应体、应用日志与依赖状态，再按故障组件处置』；切流/回滚类处置已放在需批准的 stop_loss 中。
- verification pass：verify 动作同时包含两项：『用 http.probe 复测 https://svc.example/health，要求返回 200 且 healthy=true』加『再由人工受控复现关键业务只读请求，核对错误率、延迟和实例流量』，符合『健康目标恢复并检查关键业务请求』，未用进程存活替代业务恢复。
- no_forbidden pass：未断言线程池或数据库连接池耗尽（明确写触发原因未确定）；未把单实例健康失败说成下游整体故障（仅称该实例可能不可用）；所有重启/切流/回滚均挂在批准条件下，且写明『任何重启、发布、配置修改或写操作均需另行批准，不得由本方案直接执行』。
- approvals pass：approvals 数组逐条写清：『值班负责人批准摘除实例或切流』『如涉及回滚变更，需变更负责人批准』『任何重启、发布、配置修改或写操作均需另行批准』，与标准『重启、切流、回滚需要负责人批准』对应。
- diagnosis_truth pass：交付诊断的 hypothesis『可以确认健康检查失败、服务可能不可用……触发原因未确定，不能据此断定是内存耗尽、栈溢出或依赖故障』与已知事实（503、无响应体/组件状态）及允许根因一致；candidateCauses 仅称『服务进程不可用或健康检查持续失败，具体触发逻辑未知』；建议动作均以『先由值班负责人批准』为前提，无越权断言。
- info_sufficiency pass：值班消息+详情提供了场景、节点、503 探针证据（evd-health-503-http.probe）、恢复建议和当前状态，足以让胜任的 agent 得出止损（经批准摘除/切流）、补采容器状态与日志、健康+业务双重验证的正确动作；缺失的响应体/源码已在 missingSources 说明，agent 也正确列入 unknowns 待补。

备注：方案整体合规：根因保持不确定并列入待核项，止损有明确触发条件与动作，修复为取证优先，验证覆盖健康与关键业务，批准点清晰，无禁止断言。轻微不足：repair 的补采清单未显式列出『依赖状态』一项（仅在 unknowns 提及），但不影响方向正确性。

### 源码夹具

本案例没有源码夹具。

## stack-overflow

判定：**closed**。诊断状态 completed，消息 866 字节，详情 9822 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，节点test-svc-02，JVM栈溢出场景
发生了什么：docker.logs（已截断，仅3行）显示java.lang.StackOverflowError，栈顶为com.example.Recurse.down(Recurse.java:7)重复帧，服务可用性与健康状态未知。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 批准并确认备用容量后，摘除故障实例流量、暂停已确认触发的入口任务
2. 只读采集容器与主机状态及完整日志，确认重启与资源水位
3. 按源码修复递归后受控复现验证
编号：inc-3b8f8e2a-c2db-410d-b6fe-3bb702819c86
详情获取方式：GET http://127.0.0.1:60089/v1/ops/incidents/inc-3b8f8e2a-c2db-410d-b6fe-3bb702819c86/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:60089/v1/ops/incidents/inc-3b8f8e2a-c2db-410d-b6fe-3bb702819c86/brief?format=markdown

### 处理 agent 结论

```json
{
  "rootCause": "日志可确认JVM在com.example.Recurse.down(Recurse.java:7)发生StackOverflowError，且同一帧重复出现，符合无界或过深递归耗尽线程栈；但当前仅有3行截断日志，源码夹具中没有Recurse.java，触发入口、递归终止条件、JVM -Xss配置、重启/健康检查状态及业务影响均未确认。因此可把“递归缺陷”列为高置信疑似根因，不能确认具体代码缺陷，也不能排除栈配置偏小。事件仍为OPEN，最近一次记录仍为首次发生时间，服务是否仍受影响未知，应按可能仍在影响业务处理。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先只读核查test-svc-02当前健康检查、关键业务请求成功率、容器运行/重启状态和完整日志窗口，确认故障是否仍在持续；同时确认是否存在健康对等实例可承接容量。",
      "expected": "明确当前业务影响和实例是否仍可用，避免在影响范围未知时盲目操作。"
    },
    {
      "kind": "stop_loss",
      "action": "经值班负责人批准且确认有健康对等实例承接容量后，将test-svc-02从服务发现/负载均衡摘除；仅暂停已由日志或调用链确认会触发该递归的入口任务，保留回切步骤。若无法确认触发入口，不擅自暂停其他任务。",
      "expected": "遏制栈溢出对请求和健康检查的持续影响，同时避免误伤无关业务。"
    },
    {
      "kind": "stop_loss",
      "action": "在不写入业务数据的前提下，只读采集docker.inspect（重启次数、退出码、内存限制、-Xss等启动参数）、docker.stats、host.memory、host.load，并拉取完整日志窗口替代当前截断片段。",
      "expected": "确认是否发生重启/退出、栈大小与资源水位，区分递归逻辑缺陷和栈配置偏小。"
    },
    {
      "kind": "repair",
      "action": "获取data-asset-service对应版本源码、构建产物和Recurse.down调用链，确认递归语义、终止条件及合法深度上限；修复为有界递归或迭代实现，补充边界测试和代码评审。当前源码夹具缺失，不能伪造Recurse.java或直接给出代码改动。",
      "expected": "消除可触发的无限/过深递归路径，边界用例通过并具备回滚方案。"
    },
    {
      "kind": "repair",
      "action": "修复版本发布须单独审批，采用可回滚发布；若需滚动重启实例临时恢复，也必须先审批并确认备用容量。",
      "expected": "在受控变更下恢复服务，且可快速回切。"
    },
    {
      "kind": "verify",
      "action": "在隔离或限流环境受控复现原触发条件，检查日志不再出现StackOverflowError，健康检查、线程状态和关键业务请求正常；上线后持续观察错误日志和重启次数。",
      "expected": "原触发路径不再栈溢出，服务稳定无异常重启，业务请求恢复正常。"
    }
  ],
  "approvals": [
    "摘除test-svc-02流量及暂停已确认触发入口任务，需值班负责人批准并确认备用容量与回切方案",
    "滚动重启故障实例（如采用）需单独批准并确认容量",
    "修复代码发布需代码评审、发布审批和回滚方案"
  ],
  "unknowns": [
    "test-svc-02当前健康检查、业务请求成功率和故障是否仍在持续",
    "触发该递归的业务入口、输入条件和合法递归深度",
    "Recurse.down的具体实现及终止条件；本机无源码夹具，缺少Recurse.java",
    "JVM -Xss配置、容器重启次数、退出码、OOMKilled及内存/CPU/负载水位",
    "当前3行日志为截断片段，无法确定故障窗口、发生次数和影响请求量",
    "该异常是否来自合成测试输入或仅测试环境事件，需结合完整日志与调用链核实"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写明：'同一帧重复出现，符合无界或过深递归耗尽线程栈'，并把'递归缺陷'列为高置信疑似根因，与允许根因'重复帧 Recurse.down 表明递归没有终止条件或终止条件失效'一致；同时明确'不能确认具体代码缺陷'，未断言 Java heap space 或容器 OOM kill。'-Xss 偏小'仅作为待用 docker.inspect 数据区分的次要假设保留，未被当作结论，不属于禁止断言。
- stop_loss pass：方案含条件与动作：第一条 stop_loss '先只读核查……确认故障是否仍在持续'，并指出'事件仍为OPEN……应按可能仍在影响业务处理'作为触发条件；第二条在'经值班负责人批准且确认有健康对等实例承接容量后，将test-svc-02从服务发现/负载均衡摘除；仅暂停已由日志或调用链确认会触发该递归的入口任务，保留回切步骤'。这是实际隔离动作而非仅代码分析，符合标准允许的条件式止损表述（触发条件+动作）。
- repair pass：方案 repair 动作写明'获取data-asset-service对应版本源码、构建产物和Recurse.down调用链，确认递归语义、终止条件及合法深度上限；修复为有界递归或迭代实现'，并在缺源码时明确'当前源码夹具缺失，不能伪造Recurse.java或直接给出代码改动'，完全落在允许范围'先读对应版本递归实现与终止条件，查实后修复；无法取得源码时明确需要部署版本源码、不猜测代码'之内。
- verification pass：方案 verify 动作要求'受控复现原触发条件，检查日志不再出现StackOverflowError，健康检查、线程状态和关键业务请求正常；上线后持续观察错误日志和重启次数'，覆盖了标准要求的'同一触发请求不再溢出 + 健康 + 关键业务'，不是仅用进程存活判断。
- no_forbidden pass：方案全程未把异常断言为 Java heap space 或容器 OOM kill（OOMKilled 仅列为待采集核实状态）；未提出增大堆代替修递归；重启与发布均明确受控：'若需滚动重启实例临时恢复，也必须先审批并确认备用容量'、'修复版本发布须单独审批，采用可回滚发布'，无未批准重启/发布。
- approvals pass：方案专设 approvals 清单，批准点写清：'摘除test-svc-02流量及暂停已确认触发入口任务，需值班负责人批准并确认备用容量与回切方案'、'滚动重启故障实例（如采用）需单独批准并确认容量'、'修复代码发布需代码评审、发布审批和回滚方案'，且各 action 的 requiresApproval/preconditions 与之一致。
- diagnosis_truth pass：交付诊断的 hypothesis '已确认JVM在com.example.Recurse.down(Recurse.java:7)发生StackOverflowError，栈帧为同一行重复，符合无界/过深递归耗尽线程栈'与已知事实一致，且正确承认'触发入口、合法递归深度……仍未知'、无源码不猜测；candidateCauses 首位为'递归缺少或错误使用终止条件'，与允许根因吻合，未归因 heap space 或容器 OOM kill；'-Xss 偏小'仅为需 inspect 数据区分的次要假设，非禁止断言，整体符合已知事实与允许根因。
- info_sufficiency pass：消息给出了错误类型、重复帧位置（Recurse.down:7）、严重级别与'需要优先止损'及三条恢复建议；详情含处理顺序（先止损、需批准的变更必须取得授权、'用健康响应和关键业务请求确认恢复'）及截断日志证据。胜任 agent 据此可推导出：批准后摘流/暂停触发任务、只读采集容器与主机状态、取对应版本源码确认终止条件后修递归、受控复现并查健康与关键业务，足以得出正确动作。

备注：方案与诊断均以'递归无终止条件/失效'为主根因方向，'-Xss 偏小'仅作为待采集数据区分的次要假设出现，未构成禁止断言。方案正确处理了缺源码事实（明确需要部署版本源码、拒绝伪造 Recurse.java）；agent 未点破异常源自合成测试输入（log-events.test.ts），但标准仅要求不伪造源码，方案已满足。各项均有可执行动作与触发/批准条件，无含糊表述。

### 源码夹具

本案例没有源码夹具。
