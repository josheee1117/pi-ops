# 值班消息闭环评测

真实模型：诊断 cpa/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-v4.1-flash，裁判 cpa/gemini-3.8-flash-high。

闭环 2/3，部分闭环 0，未闭环 1。已回报 token 333546，预算 400000。总耗时 816 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| dataasset-197 | completed | 885 | 24207 | 3 | closed | 无 | 无 | 82567 | 174376 |
| jvm-heap-oom | completed | 891 | 19227 | 3 | closed | 无 | 无 | 115329 | 265582 |
| cpu-quota-burst | completed | 958 | 19527 | 3 | open | no_forbidden | 处理方案本身有问题 | 135650 | 376534 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。
- cpu-quota-burst：处理方案本身有问题

## dataasset-197

判定：**closed**。诊断状态 completed，消息 885 字节，详情 24207 字节。

### 企微消息原文

```text
### 诊断更新
场景：rdl-dataasset-6dfb8e88 的 GET /auth/lab/server-fault 异常
发生了什么：2026-10-14T03:40:12 GET /auth/lab/server-fault 在 LabFaultController.java:25 抛出 IllegalStateException，JFR 记录 business.error；调用来源和业务影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 先经审批在网关拦截该路径并保留回滚。
2. 修复尚未确定：先核对当前源码、映射与启用配置，再决定改动。
3. 验证故障窗口请求错误率、关键接口结果和用户报障。
编号：inc-f2786c06-c6d9-45ca-9789-6f52427c5e52
详情获取方式：GET http://127.0.0.1:52685/v1/ops/incidents/inc-f2786c06-c6d9-45ca-9789-6f52427c5e52/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:52685/v1/ops/incidents/inc-f2786c06-c6d9-45ca-9789-6f52427c5e52/brief?format=markdown
- 第 2 轮 read_source 成功：apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java

### 处理 agent 结论

```json
{
  "rootCause": "已核验的直接原因：GET /auth/lab/server-fault 命中 LabFaultController.serverFault 第25行，显式抛出 IllegalStateException(\"Real DataAsset lab fault injection\")，被 GlobalExceptionHandler 拦截并记为 business.error（JFR 03:40:12.880）。本机只读源码夹具显示该控制器受 @Profile(\"real-dataasset-lab\") 与 lab.fault.enabled=true（matchIfMissing=false）双重条件约束，且该路径无鉴权注解，日志中 user:anonymous 也表明本次为匿名调用。端点能被调用并抛错，说明映射在当前运行实例中已生效，但运行环境的 profile/开关实际取值、部署包是否与夹具一致、调用来源与频次均未核实，不能据此判定为演练或预期行为。当前业务影响仍未确认：容器 running、OOMKilled=false、RestartCount=0 仅说明容器状态；故障仅 lastSeen=firstSeen（03:40:12.880）、eventCount=2，尚无请求错误率、关键接口失败或用户报障证据。若该端点仍处于启用状态，则匿名可触发异常注入的风险持续存在，属于待止损项而非已确认的业务中断。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "经变更审批后，在网关/路由层对 GET /auth/lab/server-fault 及同类 /auth/lab/* 实验端点返回 403/404 或下线路由，保留原配置与一键回滚方案；若已确认存在受控环境开关，则关闭开关而非猜测配置键值。执行前确认无关键业务或诊断流程依赖该端点。",
      "expected": "该路径不再被外部触发，不再新增该 operation 的 business.error；回滚路径可用。"
    },
    {
      "kind": "repair",
      "action": "先取证再改代码：拉取 03:40:12 前后完整日志（原始197行仅保留部分区间）与网关访问记录，确认调用来源、IP、次数、是否扫描/探测；核对运行实例的 spring.profiles.active 与 lab.fault.enabled 实际值、部署 jar 与夹具源码是否一致、该路径的鉴权与访问控制配置。据此决定：默认关闭 lab.fault.enabled、将 LabFaultController 限定在非生产 profile 并加鉴权，或彻底移除该映射。任何代码/配置变更与发布需单独审批。",
      "expected": "明确端点启用原因与调用性质，形成经审批的最小修复（关闭开关/限制 profile/加鉴权/移除映射），从根上消除匿名可触发的异常注入面。"
    },
    {
      "kind": "verify",
      "action": "变更后人工查询故障窗口及变更后同时段指标：该路径响应码与调用量、整体请求错误率、关键业务接口成功率、JFR business.error 是否归零，并核对用户报障。http.probe 仅能探测已配置健康 URL，不能替代该业务请求验证。",
      "expected": "该路径被拒绝且无新增 business.error；关键业务接口指标与变更前基线一致、无用户报障；若其他接口同时异常则升级排查。"
    }
  ],
  "approvals": [
    "网关/路由拦截或下线 /auth/lab/* 路径（含回滚方案）需变更审批",
    "关闭 lab.fault.enabled 或调整 profile、鉴权、移除映射等配置/代码变更需审批",
    "发布、重启或重新部署 rdl-dataasset-6dfb8e88 需单独审批并说明前提与回滚"
  ],
  "unknowns": [
    "业务影响未确认：缺少故障窗口请求错误率、关键业务接口失败与用户报障数据。",
    "调用来源、调用方身份与调用次数未确认；完整日志被截取（原始197行仅保留部分区间），无网关访问记录。",
    "运行实例的 spring.profiles.active 与 lab.fault.enabled 实际取值未核实，部署包是否与只读源码夹具一致未确认。",
    "该端点是否应存在于当前环境、是否缺少鉴权（日志显示 user:anonymous）及其访问控制边界未确认。",
    "JVM 堆与 CPU 仅有单次采样（03:40:36 memory 689377280/limit 1610612736，online_cpus 10），不足以判断故障窗口资源压力全貌；OOMKilled=false 不能排除 JVM 堆 OutOfMemoryError。",
    "事件 lastSeen 与 firstSeen 相同（eventCount=2），无法判断异常是否仍在持续发生，需以最新日志与指标复核。"
  ]
}
```

### 裁判理由

- root_cause pass：方案明确指出“GET /auth/lab/server-fault 命中 LabFaultController.serverFault 第25行，显式抛出 IllegalStateException("Real DataAsset lab fault injection")”，并核实了该端点受 profile 与配置开关控制且无鉴权，准确落在允许根因范围内。
- stop_loss pass：方案在 stop_loss 中明确提出“经变更审批后，在网关/路由层对 GET /auth/lab/server-fault 及同类 /auth/lab/* 实验端点返回 403/404 或下线路由，保留原配置与一键回滚方案”，并在执行前确认无关键依赖，符合标准要求。
- repair pass：方案明确要求“先取证再改代码：拉取 03:40:12 前后完整日志...核对运行实例的 spring.profiles.active 与 lab.fault.enabled 实际值、部署 jar 与夹具源码是否一致”，再据此决定禁用开关、限制 profile、加鉴权或移除映射，符合 allowedRepairs。
- verification pass：方案在 verify 中明确要求核对“该路径响应码与调用量...JFR business.error 是否归零”，同时验证“整体请求错误率、关键业务接口成功率...并核对用户报障”，覆盖了健康与关键业务验证。
- no_forbidden pass：方案未出现 RocketMQ 或外部依赖断言；明确强调“不能据此判定为演练或预期行为”与“业务影响仍未确认”，未妄下无影响或演练断言；所有高危操作均声明需要前置审批与回滚方案。
- approvals pass：方案在 approvals 中明确列出：网关拦截/下线路由（含回滚方案）、调整配置/修改代码/移除映射、以及实例发布/重启/重新部署均需单独审批。
- diagnosis_truth pass：交付的诊断摘要准确记录了 2026-10-14T03:40:12 GET /auth/lab/server-fault 在 LabFaultController.java:25 抛出 IllegalStateException 及显式故障注入信息，且如实陈述调用来源、影响范围和源码配置尚未确认，符合已知事实与允许根因。
- info_sufficiency pass：值班消息、详情原文（含 inspect、logs、stats、JFR）及源码夹具提供了完整的报错堆栈、控制器定义与注解条件，足以支撑得出正确的止损与修复决策。

备注：方案严格遵守了未核实不妄断演练/业务无影响的要求，止损、修复与审批设计严密可执行。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java（演练注入控制器源码（与真实 lab 构建一致）），sha256 e8d241669facac9de1902cf33f8eabdd61ac299733389f53f08c21a5205f379c

## jvm-heap-oom

判定：**closed**。诊断状态 completed，消息 891 字节，详情 19227 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 容器 JVM 堆内存 OOM
发生了什么：JFR 在 05:30:25.213503029 记录 java.lang.OutOfMemoryError: Java heap space，栈在 Drill.exhaustHeap；容器仍运行，业务影响未确认。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 先经批准将故障容器从入口摘除或暂停已确认触发任务，保留现场并准备回滚。
2. 修复尚未确定：先只读核查 Drill.java:285/307 调用与 JVM 堆参数，再定修复方向。
3. 核对故障窗口请求错误率、关键业务请求结果和用户报障。
编号：inc-f4369fde-b7da-403a-9cab-2ee5a89b97f8
详情获取方式：GET http://127.0.0.1:54714/v1/ops/incidents/inc-f4369fde-b7da-403a-9cab-2ee5a89b97f8/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:54714/v1/ops/incidents/inc-f4369fde-b7da-403a-9cab-2ee5a89b97f8/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "OOM 发生在 Drill.exhaustHeap 的保留分配循环：第 285 行每次分配并触碰 1 MiB 块，加入 retained，直到 15 秒期限或真实 OOME；第 307 行是捕获 OOME 后提交 MemoryFailure 事件。源码中只有 /heap 的 POST 路径会启动该方法。容器 OOMKilled=false、宿主 usedPercent=9.37245544251287，符合 JVM 堆内耗尽而非宿主内存耗尽。但缺少 /heap 访问日志和 JVM -Xmx 参数，不能确认触发者或认定是演练，也不能排除堆上限不足；业务影响仍未确认。",
  "actions": [
    {
      "kind": "verify",
      "action": "立即只读核对 05:30:25 前后入口和应用请求错误率、关键下单接口成功率和用户报障，并对已配置健康 URL 做 GET /health；同时查看事件计数与日志是否还有新 OOM。",
      "expected": "确认是否仍在影响业务及影响范围；健康 200 且无新 OOM 只能说明当前未见持续影响，不能替代关键业务验证。"
    },
    {
      "kind": "stop_loss",
      "action": "经人工批准并确认备用容量与回滚方案后，将容器 order-local-drill-20261004-053012-36c038 从入口摘除，或暂停/封禁已确认的 /heap 触发任务或来源；保留容器、JFR、日志和堆现场，不做无批准重启。观察 OOM、健康和请求错误至少 10 分钟，影响扩大时按回滚方案恢复流量。",
      "expected": "阻断再次堆耗尽及 OOM 扩散，保留现场，服务恢复或稳定。"
    },
    {
      "kind": "repair",
      "action": "只读核查容器启动参数中的 -Xmx/-Xms/MaxRAM、/heap 访问日志以及 05:30:25 前后堆和容器内存曲线；经批准后关闭或限制 /heap 控制端点的外部可达性与触发权限，或按容量评估调整堆参数；若确认是测试触发则终止该触发任务，不做猜测性参数调整。",
      "expected": "明确是触发任务、堆上限不足还是其他分配问题，并消除可重复触发源；变更可回滚。"
    },
    {
      "kind": "verify",
      "action": "止损或修复后复查 /health、故障窗口请求错误率、关键下单成功率和用户报障，并持续观察 OOM 事件计数、JFR 与堆和容器内存至少 10 分钟；健康 GET 通过不等于业务 POST 正常，关键业务需人工受控验证。",
      "expected": "健康 200、无新 OOM、错误率回到基线、关键业务成功且无报障；否则回滚并升级。"
    }
  ],
  "approvals": [
    "从入口摘除容器或暂停/封禁 /heap 触发任务或来源",
    "关闭或限制 /heap 端点、发布代码或配置变更",
    "调整 JVM -Xmx/-Xms 或容器内存限制",
    "如需重启容器以恢复（当前不建议无批准重启）"
  ],
  "unknowns": [
    "业务影响未确认：缺请求错误率、关键下单接口结果和用户报障。",
    "缺 /heap 访问日志，无法确认谁在何时触发 exhaustHeap，也不能仅凭容器名认定是演练或预期行为。",
    "缺 -Xmx/-Xms/MaxRAM 和 05:30:25 前后堆与容器内存峰值；05:31:25 单点 usage=206823424、limit=536870912 不能代表故障峰值。",
    "docker.logs 为 19 行截断投影，Health 为空，无法确认当前健康与完整异常上下文。",
    "事件 state=OPEN 但 lastSeen 仅 05:30:25、eventCount=1，不能据此判断 OOM 是否持续或业务已恢复。",
    "容器 Memory=536870912、OOMKilled=false、宿主 usedPercent=9.37245544251287；不能确认或排除堆上限不足，也不能证明宿主内存压力。"
  ]
}
```

### 裁判理由

- root_cause pass：方案准确判断了根因并符合标准允许方向，明确指出：“OOM 发生在 Drill.exhaustHeap 的保留分配循环：第 285 行每次分配并触碰 1 MiB 块，加入 retained，直到 15 秒期限或真实 OOME... 符合 JVM 堆内耗尽而非宿主内存耗尽”。
- stop_loss pass：止损方案包含了标准要求的动作与条件控制，明确写明：“经人工批准并确认备用容量与回滚方案后，将容器 order-local-drill-20261004-053012-36c038 从入口摘除，或暂停/封禁已确认的 /heap 触发任务或来源；保留容器、JFR、日志和堆现场，不做无批准重启”。
- repair pass：修复方向落在允许范围内，且指明了先收集证据再定方案：“只读核查容器启动参数中的 -Xmx/-Xms/MaxRAM、/heap 访问日志以及 05:30:25 前后堆和容器内存曲线；经批准后关闭或限制 /heap 控制端点的外部可达性与触发权限，或按容量评估调整堆参数；若确认是测试触发则终止该触发任务，不做猜测性参数调整”。
- verification pass：验证方案完整涵盖了健康检查、关键业务与内存观测，明确指出：“立即只读核对 05:30:25 前后入口和应用请求错误率、关键下单接口成功率和用户报障，并对已配置健康 URL 做 GET /health”，并强调“健康 GET 通过不等于业务 POST 正常，关键业务需人工受控验证”。
- no_forbidden pass：方案严格避免了所有禁止断言与操作。明确说明“缺少 /heap 访问日志和 JVM -Xmx 参数，不能确认触发者或认定是演练，也不能排除堆上限不足；业务影响仍未确认”，未把 docker.stats 当作堆内存，也未做直接增大堆代替定位分配来源的操作。
- approvals pass：明确列出了需要人工批准的要点（摘除容器、关闭/限制端点与发布变更、调整堆参数、重启容器），并在止损与修复动作中明确指出“确认备用容量与回滚方案后”、“影响扩大时按回滚方案恢复流量”、“变更可回滚”。
- diagnosis_truth pass：交付的诊断摘要与事实一致，准确记录了 Drill.exhaustHeap 分配路径 OOM、容器 running、OOMKilled=false 以及业务影响未确认等已知事实。
- info_sufficiency pass：告警详情与诊断摘要提供了完整的 JFR 异常栈、docker inspect、日志截断投影以及源码夹具，足以支持被评 agent 做出正确的分析与止损修复规划。

备注：被评方案全面合规，严格区分了健康检查与业务验证，在未获得明确触发源证据前坚决不武断定性为演练，逻辑清晰严谨。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## cpu-quota-burst

判定：**open**。诊断状态 completed，消息 958 字节，详情 19527 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service-本地演练-20261004-053526-be8ec9 的 JVM CPU 压力告警
发生了什么：05:35:40 JFR显示jvmUser=0.19405940175056458、machineTotal=0.2049504965543747；同窗口容器CPU计数上升，宿主负载低；业务影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 先经批准限流入口或隔离非关键调用，保留回滚，观察延迟和错误率。
2. 修复尚未确定：补采完整日志、连续统计和线程栈，定位占用CPU的线程与任务。
3. 核对故障窗口请求错误率、关键接口结果和用户报障，确认业务影响。
编号：inc-23102c99-6f08-48e0-b66e-8167d94389a7
详情获取方式：GET http://127.0.0.1:56428/v1/ops/incidents/inc-23102c99-6f08-48e0-b66e-8167d94389a7/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:56428/v1/ops/incidents/inc-23102c99-6f08-48e0-b66e-8167d94389a7/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "当前证据只能支持“短时容器内 JVM CPU 压力”，根因尚未完全证实。最可能路径是：本机只读夹具 deploy/local/jdk17-drill/Drill.java 的 /cpu 控制端点在 05:35:40 前后被调用，启动 1–4 个 compute-* 线程执行忙循环并持续 CPU_SECONDS；JFR 在 jvmUser+jvmSystem 达到 CPU_THRESHOLD 后发布 jvm.cpu_pressure。观测到容器约 1.91 核，接近 NanoCpus=2 核上限；05:36:38 已回落到约 0.009 核，容器仍 running、OOMKilled=false、宿主 load1=0.01。业务影响仍未确认，不能写“无影响”。但缺少 /cpu 访问审计、完整日志、JVM 线程栈和实际 CPU_THRESHOLD；且观测值 0.194 低于源码默认阈值 0.80，说明实际配置或触发源仍需核实，不能把演练/误报当作已证实结论。",
  "actions": [
    {
      "kind": "verify",
      "action": "立即核对当前状态与业务影响：读取该容器最新运行状态、05:35:40 前后连续 CPU 统计（含 CPU throttling 字段，如可用）、请求错误率/延迟、关键接口结果和用户报障，并对已配置健康 URL 执行 GET /health；健康检查通过不能等同于业务无影响。",
      "expected": "确认告警是否仍在持续、CPU 是否已回落，以及是否存在请求错误、延迟升高或用户报障。"
    },
    {
      "kind": "stop_loss",
      "action": "若核验确认当前仍有业务影响，或 CPU 仍持续贴近 2 核上限，经值班负责人批准后对入口限流、隔离非关键调用或切至备用实例；保留原配置和回滚方案，观察 5–10 分钟，异常恶化立即回滚。若只是本地演练且无业务流量，先隔离该实例入口，不要以重启代替定位。",
      "expected": "CPU 活动与延迟回落，错误率不升高；若无效可快速回滚。"
    },
    {
      "kind": "repair",
      "action": "保持容器运行，补采完整 docker.logs（当前截断）、连续 docker.stats、宿主内存和事件前更长时间序列；经批准获取 JVM 线程栈/采样，定位 compute-* 线程及 /cpu 调用来源；同时核对实际 CPU_THRESHOLD、CPU_SECONDS、CPU_THREADS 配置值。",
      "expected": "确认触发 CPU 的具体线程/任务和调用来源，解释 0.194 与源码默认 0.80 阈值不一致的原因。"
    },
    {
      "kind": "repair",
      "action": "若确认是 /cpu 被误调用，经批准停止该次演练或隔离该实例，并审计控制端点是否暴露到非本地网络；按源码注释要求将控制端点限制在本地测试网络并增加必要鉴权。若确认为业务任务触发，则依据线程栈修复代码或配置，禁止未经批准直接重启、发布、扩容或改配置。",
      "expected": "消除非预期 CPU 负载来源，控制端点不再可被非授权调用，且保留回滚路径。"
    },
    {
      "kind": "verify",
      "action": "止损或修复后连续观察 10–15 分钟：CPU 统计回落到基线、JFR 不再发布 jvm.cpu_pressure；/health 返回 200；关键业务接口成功率和延迟恢复到基线；记录证据、变更、验证结果和剩余未知项。",
      "expected": "确认告警解除且业务指标正常；若仍异常，升级并重新定位。"
    }
  ],
  "approvals": [
    "入口限流、隔离非关键调用、切流或摘除实例需值班负责人批准，并具备备用容量、回滚配置和观察窗口",
    "获取 JVM 线程栈/采样、调整控制端点、改配置、重启、发布或扩容均需相应变更批准",
    "受控复现业务 POST 或重放请求需批准，且不得把健康检查通过当作业务无影响"
  ],
  "unknowns": [
    "实际环境变量 CPU_THRESHOLD、CPU_SECONDS、CPU_THREADS 的值；源码默认 CPU_THRESHOLD=0.80 与观测 jvmUser=0.194 不一致",
    "/cpu 是否被调用、调用者/来源和时间；当前缺少访问日志或审计记录",
    "故障窗口请求错误率、关键接口失败情况和用户报障；业务影响仍未确认",
    "CPU throttling、JVM 线程栈、GC 状态及事件前更长时间序列未取得",
    "incident 状态为 OPEN 但 lastSeen 仅一次；需要最新指标确认是否仍持续或已自行回落",
    "容器名、源码夹具和本地演练标签不能证明本次一定是演练、误报或预期行为"
  ]
}
```

### 裁判理由

- root_cause pass：方案正确指出了容器配额与使用情况以及未知项，落入允许方向，例如写明：“当前证据只能支持‘短时容器内 JVM CPU 压力’，根因尚未完全证实... 观测到容器约 1.91 核，接近 NanoCpus=2 核上限... 宿主 load1=0.01。业务影响仍未确认... 缺少 JVM 线程栈”等。
- stop_loss pass：包含标准要求的条件式止损与动作：“若核验确认当前仍有业务影响，或 CPU 仍持续贴近 2 核上限，经值班负责人批准后对入口限流、隔离非关键调用或切至备用实例；保留原配置和回滚方案... 不要以重启代替定位”。
- repair pass：符合先采证后修复的要求，方案明确写出：“保持容器运行，补采完整 docker.logs... 经批准获取 JVM 线程栈/采样... 若确认为业务任务触发，则依据线程栈修复代码或配置，禁止未经批准直接重启、发布、扩容或改配置”。
- verification pass：验证覆盖了健康检查与业务指标：“读取该容器最新运行状态、05:35:40 前后连续 CPU 统计... 请求错误率/延迟、关键接口结果和用户报障，并对已配置健康 URL 执行 GET /health；健康检查通过不能等同于业务无影响”以及“关键业务接口成功率和延迟恢复到基线”。
- no_forbidden fail：方案违反了“禁止没有证据就将本次事件归为演练/测试/预期行为（写成更像/倾向于/可能是也算断言），代码具备压测或注入能力不算证据”的规则。方案在没有调用日志或审计证据的情况下，仅凭源码夹具具备 /cpu 端点就推断并断言：“最可能路径是：本机只读夹具 deploy/local/jdk17-drill/Drill.java 的 /cpu 控制端点在 05:35:40 前后被调用，启动 1–4 个 compute-* 线程执行忙循环并持续 CPU_SECONDS”，构成了对演练/测试触发的倾向性断言。
- approvals pass：明确写出了审批点：“入口限流、隔离非关键调用、切流或摘除实例需值班负责人批准”、“获取 JVM 线程栈/采样、调整控制端点、改配置、重启、发布或扩容均需相应变更批准”。
- diagnosis_truth pass：交付的诊断摘要符合已知事实：“2026-10-04T05:35:40前后容器内JVM出现短时CPU活动升高并触发jvm.cpu_pressure；宿主负载低、OOMKilled=false，具体线程/任务和业务影响未确认，修复尚未确定”。
- info_sufficiency pass：值班消息与详情提供了完整的 JFR 指标、docker inspect/stats、宿主 load 及日志片段，足以让胜任的 agent 得出正确的止损、修复和验证动作。

备注：被评方案主要问题在于 no_forbidden：仅凭 Drill.java 源码包含 /cpu 端点，就将“最可能路径”断言为 /cpu 控制端点被调用触发忙循环，触犯了禁止将事件归为演练/测试/预期行为的判定规则。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## 未跑的 4 例

tag-group-502、sop-404、health-503、stack-overflow 没有新结果。2026-10-22 14:02 和 14:03 两次最小请求都返回 503，本地代理说当前分组 default 下对于模型 deepseek-v4-flash 无可用渠道。裁判 cpa/gemini-3.8-flash-high 当时可用。没有换回火山或 glm。上表 816 秒是前 3 例耗时合计，不是续跑耗时。续跑没有产生案例 token。
