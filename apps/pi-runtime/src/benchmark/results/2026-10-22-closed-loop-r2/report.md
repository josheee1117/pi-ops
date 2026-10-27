# 值班消息闭环评测

真实模型：诊断 ark/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。

闭环 2/2，部分闭环 0，未闭环 0。已回报 token 140711，预算 250000。总耗时 468 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| cpu-quota-burst | completed | 844 | 19206 | 3 | closed | 无 | 无 | 72395 | 246351 |
| jvm-heap-oom | completed | 812 | 19476 | 3 | closed | 无 | 无 | 68316 | 222127 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。

本批没有未闭环案例，所有卡点列为空。

## cpu-quota-burst

判定：**closed**。诊断状态 completed，消息 844 字节，详情 19206 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 本地容器 order-local-drill-20261004-053526-be8ec9，节点 local-dev
发生了什么：JVM 用户态 CPU 短时升至 0.19405940175056458 触发 jvm.cpu_pressure；容器运行中、OOMKilled=false，主机负载低，影响未确认。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 补采 CPU 节流与完整日志，核对请求错误率
2. 若持续打满，经批准隔离流量或暂停触发任务
3. 重启或调整资源后验证 JFR 与 stats 是否回落
编号：inc-172a2904-47ee-4db6-ad19-0caa6bec4073
详情获取方式：GET http://127.0.0.1:59255/v1/ops/incidents/inc-172a2904-47ee-4db6-ad19-0caa6bec4073/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:59255/v1/ops/incidents/inc-172a2904-47ee-4db6-ad19-0caa6bec4073/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "现有证据只能支持“容器内 JVM 用户态 CPU 短时接近自身 2 核配额”，不能确认业务影响，也不能确认具体触发代码路径。可核验事实：1) jdk.CPULoad 单点事件 jvmUser=0.19405940175056458、jvmSystem=0、machineTotal=0.2049504965543747（inc-172a2904 首轮 brief，证据 jfr-207e8fdb）；按 jdk.CPULoad 语义 jvmUser 是整机 10 核的比例，0.194×10≈1.94 核，与 docker.inspect 的 NanoCpus=2000000000（2 核）接近打满，而 host.load load1=0.01/10 核说明不是主机争抢。2) 相同窗口 docker.stats 的 total_usage 增量 5055491000-3128858000=1926633000ns、间隔约 1.0065s，折算≈1.91 核，与上述比例一致，说明该时刻容器确实把自身配额用满；但两份 stats 均未含 cpu.throttling_data，无法判断是否被 cgroup 节流。3) 容器 05:35:27.81Z 启动，事件 05:35:40.15Z，约启动后 12 秒；日志只覆盖 05:35:29–05:35:39 且 jvmUser 多在 0.001 量级，事件当秒及之后的日志缺失，无法区分“启动/JIT 期瞬时突发”与“外部触发计算负载”。源码夹具 deploy/local/jdk17-drill/Drill.java 显示：POST /cpu 会起 CPU_THREADS(1–4) 个线程忙等 CPU_SECONDS(1–30s) 制造真实用户态 CPU（第 222–242 行）；第 189–192 行注释明确分类只看采样值、不依赖控制端点状态，因此无法用端点状态反推是否被调用；同时 jvm.cpu_pressure 阈值来自环境变量 CPU_THRESHOLD（默认 0.80，第 77 行），若为默认值，在 2 核/10 核配额下 jvmUser 上限约 0.2、0.194 也几乎不可达，故容器内 CPU_THRESHOLD 很可能被下调（如 ≤0.194），本次信号也可能是阈值口径与容器配额不匹配造成的灵敏度偏高——但环境变量实际值未提供，属待核实项。容器名含 drill、镜像名为 jdk17-drill 均不构成演练或误报的证明，本结论按真实告警处理；OOMKilled=false 也不能排除 JVM 堆 OOM（本次未见 MemoryFailure/jvm.oom 事件）。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先只读确认影响边界，不做任何变更：GET /health 探活（源码第 219 行，200/503），并拉取 2026-10-04T05:35:40Z 前后各 5–15 分钟的请求错误率、关键下单接口成功率与用户报障，对比正常时段；同时确认是否仍有客户端在调用控制端点 POST /cpu（该端点会制造 1–4 线程、1–30 秒真实 CPU 负载）。",
      "expected": "明确健康状态是否为 200、业务错误率是否出现异常抬升，从而判定“仍在影响业务/仅瞬时信号”，为是否止损提供依据。"
    },
    {
      "kind": "stop_loss",
      "action": "在影响未确认前，禁止任何新的 POST /cpu、/heap 触发；如核实存在仍在持续的 CPU 触发源或控制端点被非本地访问，经值班负责人批准后，用网络策略限制该容器控制端点的入向访问（或隔离来源），不直接重启容器。",
      "expected": "切断可能的计算负载触发源，CPU 不再因外部触发升高；服务在途请求不受影响。"
    },
    {
      "kind": "repair",
      "action": "仅在确认 CPU 持续打满且已影响业务时，由值班负责人批准并明确可回滚点后处置：先隔离故障流量或暂停已确认的触发任务；必要时重启容器，重启前记录镜像 pi-ops-jdk17-local-jdk17-drill、NanoCpus=2000000000、Memory=536870912 与当前 CPU_THRESHOLD/CPU_SECONDS/CPU_THREADS 环境值，保持可回滚；重启只恢复当前实例，不解决根因。",
      "expected": "CPU 回落到配额以下，jvm.cpu_pressure 不再重复上报，容器 healthy；同时保留复现与回滚所需配置。"
    },
    {
      "kind": "repair",
      "action": "若核实 CPU_THRESHOLD 取值与容器 2 核配额口径不匹配（jvmUser 为整机 10 核比例，上限≈0.2），按变更流程评审是否调整为与容器配额/业务 SLO 匹配的阈值（或改为基于 throttle/配额比例判定），调整前需评审并保留旧值以便回滚；本次不直接改配置。",
      "expected": "后续告警灵敏度与容器实际配额口径一致，避免单点 0.19 采样反复触发或掩盖真实压力。"
    },
    {
      "kind": "verify",
      "action": "连续补采覆盖 05:35:40Z 前后及事件后≥1 分钟的 docker.stats（必须含 cpu.throttling_data、完整 cpu_usage 与在线 CPU 数）和未截断的 docker.logs，并采集线程级诊断（如 jcmd Thread.print / JFR 执行采样）以定位热点线程与代码路径；采集频率不宜过高，避免增加负载。",
      "expected": "得到 throttle 计数与是否存在被节流的证据、CPU 峰值与持续时间、05:35:40Z 当秒日志，以及热点方法（例如是否落在 Drill 的 compute-* 线程或启动期 JIT/字节码编译）。"
    },
    {
      "kind": "verify",
      "action": "处置后按同一口径复验：GET /health 返回 200、关键下单接口成功率无异常、docker.stats 采样中 jvm 用户态折算核数稳定低于 2 核配额、连续≥10 分钟无新增 jvm.cpu_pressure，并记录修复与残留未知项。",
      "expected": "健康与关键业务请求正常、CPU 与事件量回落并稳定，判定可关闭或降级为观察。"
    }
  ],
  "approvals": [
    "隔离故障流量 / 暂停已确认触发任务：需值班负责人批准，并明确业务窗口与在途请求影响",
    "重启容器：需值班负责人批准，且先记录镜像、NanoCpus/内存配置与回滚点",
    "限制 Drill 控制端点入向访问（网络策略/隔离来源）：需值班负责人批准",
    "调整 CPU_THRESHOLD 或容器资源配额：需变更评审批准，保留旧值与回滚方案",
    "读取原始证据（/v1/ops/incidents/.../evidence?view=raw）可能含敏感信息：需在授权环境内进行"
  ],
  "unknowns": [
    "业务影响仍未确认：无请求错误率、关键接口结果、用户报障与真实 /health 探测结果",
    "故障窗口 CPU 峰值、持续时长与实际是否被 cgroup 节流（throttling_data 未采集）",
    "触发代码路径未知：日志截断缺失 05:35:40Z 当秒及之后内容，无执行采样/线程栈，无法区分启动期 JIT 突发、Drill /cpu 计算负载还是业务代码热点",
    "容器内实际环境变量 CPU_THRESHOLD、CPU_SECONDS、CPU_THREADS、SENDER_ENABLED 取值未提供；若 CPU_THRESHOLD 为默认 0.80，则本次 0.194 触发在口径上不自洽，需核实",
    "是否存在对 POST /cpu 等控制端点的外部调用及其来源",
    "证据存在内部不一致：诊断文本称 docker.logs“原 74 行中保留前 12 行”，而证据投影为 originalLineCount=12、保留 1–12 行，实际截断程度需以原始证据核对",
    "是否为演练/预期行为：容器名与源码注释仅作线索，不能作为定性依据，需环境负责人确认",
    "OOMKilled=false 不能排除 JVM 堆 OOM；本轮未见 MemoryFailure/jvm.oom 事件，但内存仅在 111MB/512MB 单点采样，长时间堆与 GC 行为未采集"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因判断落在允许方向内：明确写“现有证据只能支持‘容器内 JVM 用户态 CPU 短时接近自身 2 核配额’”，并正确换算口径“jvmUser 是整机 10 核的比例，0.194×10≈1.94 核，与 docker.inspect 的 NanoCpus=2000000000（2 核）接近打满”，同时用 stats 增量折算≈1.91 核佐证，符合允许根因“接近配额上限，可能存在 throttling”；又指出“host.load load1=0.01/10 核说明不是主机争抢”且“具体热点代码与触发路径未知”，对应允许根因“机器 10 核整体未饱和；具体线程热点与业务影响未知”。阈值口径疑点被写成待核实项（“环境变量实际值未提供，属待核实项”），未替换根因，也未据此定性好报。
- stop_loss pass：包含条件式止损且写出触发条件与动作：stop_loss 动作 2 写明“在影响未确认前，禁止任何新的 POST /cpu、/heap 触发；如核实存在仍在持续的 CPU 触发源或控制端点被非本地访问，经值班负责人批准后，用网络策略限制该容器控制端点的入向访问（或隔离来源），不直接重启容器”；repair 动作 1 亦写“仅在确认 CPU 持续打满且已影响业务时……先隔离故障流量或暂停已确认的触发任务”，与标准“经批准暂停高负载触发源”一致，且“影响确认前不直接重启”对应“影响确认前不要盲目扩容或重启”。
- repair pass：修复方向在允许范围：先取证据再修的要求明确写出所需物——verify 动作写“连续补采……docker.stats（必须含 cpu.throttling_data、完整 cpu_usage 与在线 CPU 数）和未截断的 docker.logs，并采集线程级诊断（如 jcmd Thread.print / JFR 执行采样）以定位热点线程与代码路径”，对应“先取线程/JFR 热点或配额对照”；“暂停已确认的触发任务”对应条件暂停触发源；阈值/配额调整写成“按变更流程评审……本次不直接改配置”，未未经批准执行。
- verification pass：验证包含健康与关键业务，非仅进程存活：verify 动作写“处置后按同一口径复验：GET /health 返回 200、关键下单接口成功率无异常、docker.stats 采样中 jvm 用户态折算核数稳定低于 2 核配额、连续≥10 分钟无新增 jvm.cpu_pressure”，另有 stop_loss 动作 1 核对“请求错误率、关键下单接口成功率与用户报障”。机器整体未饱和已在根因分析中用 host.load(load1=0.01、cpus=10) 论证，唯处置后复验步骤未显式重查 host 负载，属小缺但不影响达标。
- no_forbidden pass：未触犯禁止项：未把机器归一化比例当配额利用率，而是先换算“0.194×10≈1.94 核”再对照 2 核配额；未声称整机饱和或已确认热点（写“无法区分启动期 JIT 突发、Drill /cpu 计算负载还是业务代码热点”）；重启/限流/改配额均挂批准，未直接执行；关于演练定性明确写“容器名含 drill、镜像名为 jdk17-drill 均不构成演练或误报的证明，本结论按真实告警处理”，unknowns 中将“是否为演练/预期行为”列为待确认而非断言；业务影响写“不能确认业务影响”“业务影响仍未确认”，无“未受影响”断言；stop_loss 中“服务在途请求不受影响”是对所提议网络策略作用面的预期，非对本次事件影响的断言。
- approvals pass：批准点写清：approvals 列出“隔离故障流量 / 暂停已确认触发任务：需值班负责人批准”“重启容器：需值班负责人批准，且先记录镜像、NanoCpus/内存配置与回滚点”“调整 CPU_THRESHOLD 或容器资源配额：需变更评审批准，保留旧值与回滚方案”，并额外标注限制控制端点网络访问需批准、读原始证据需授权环境，覆盖标准要求的重启与调配额/扩容类变更。
- diagnosis_truth pass：交付诊断符合已知事实与允许根因：hypothesis 如实陈述 jvmUser=0.194、machineTotal≈0.205、load1=0.01/cpus=10、NanoCpus=2000000000，并写明“故障窗口内 CPU 峰值、持续时间和 throttle 未采集，请求错误率与用户报障未确认”；candidateCauses 分别为“JVM 自身短时用户态 CPU 升高……具体热点代码与触发路径未知”与“容器 CPU 配额竞争或节流……无法确认”，均落在允许根因方向；recommendation 明确“环境标签与容器名不作演练定性，OOMKilled=false 不排除 JVM 堆 OOM”，未断言无影响或演练。
- info_sufficiency pass：消息+详情足以得出正确动作：详情含 docker.inspect(NanoCpus=2000000000)、两份 docker.stats（可用 total_usage 增量折算≈1.91 核）、host.load(cpus=10, load1=0.01)、截断日志与源码夹具（/cpu 注入能力与 CPU_THRESHOLD 逻辑），胜任的 agent 可据此完成配额对照、影响核实与条件式止损规划；被评 agent 恰好据此完成了正确换算与分级处置设计。

备注：整体合格。唯一小瑕疵：处置后复验步骤未显式包含“复查机器整体负载”，但机器未饱和已由 host.load 证据在根因分析中论证；阈值口径疑点（CPU_THRESHOLD 可能被下调）被正确标为待核实项而非演练/误报定性。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## jvm-heap-oom

判定：**closed**。诊断状态 completed，消息 812 字节，详情 19476 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service 本地容器 order-local-drill-20261004-053012-36c038 的JVM
发生了什么：JFR捕获java.lang.OutOfMemoryError: Java heap space，栈顶为Drill.exhaustHeap；容器仍running、OOMKilled=false，宿主机usedPercent 9.37%
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 获批后隔离该实例流量或重启容器，恢复可用性
2. 补采堆与GC指标并读源码定位分配来源
3. 核对故障窗口请求错误率与用户报障确认影响
编号：inc-3f4fca09-9f67-4407-bc02-98152c6f4dcb
详情获取方式：GET http://127.0.0.1:62030/v1/ops/incidents/inc-3f4fca09-9f67-4407-bc02-98152c6f4dcb/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

- 第 1 轮 fetch_details 成功：http://127.0.0.1:62030/v1/ops/incidents/inc-3f4fca09-9f67-4407-bc02-98152c6f4dcb/brief?format=markdown
- 第 2 轮 read_source 成功：deploy/local/jdk17-drill/Drill.java

### 处理 agent 结论

```json
{
  "rootCause": "JFR与只读源码一致：java.lang.OutOfMemoryError: Java heap space 由 Drill.exhaustHeap 抛出，该方法只由 POST /heap 控制端点启动的 allocation 线程调用，循环每次分配 1MiB 并触页，直到 OOME 或 15 秒上限；捕获后释放 retained、System.gc()、heapActive 复位，并提交 MemoryFailure 事件。日志在 OOM 后紧接 'Allocation work completed; retained memory released'。因此本次是控制端点触发的受控堆耗尽，不是宿主机内存压力（usedPercent 9.37%）、也不是容器级 OOM kill（running、OOMKilled=false、RestartCount=0）；事件后约60秒 stats 显示容器内存 206823424/536870912，无泄漏证据。但 OOM 期间是否影响在途业务请求、错误率与用户报障仍未核实，不能据此判定业务未受影响。",
  "actions": [
    {
      "kind": "stop_loss",
      "action": "先不重启：立即只读核对 /health 与 2026-10-04T05:30:25 前后请求错误率、超时和用户报障；若 /health 非 200、错误率持续升高或 OOM 复现，经值班负责人批准后隔离该实例流量或重启容器，并保留当前镜像与容器配置快照作为回滚。",
      "expected": "确认故障是否仍在影响业务；必要时恢复可用性，同时保留现场与回滚能力。"
    },
    {
      "kind": "repair",
      "action": "查清 2026-10-04T05:30:25 前后谁或哪个任务调用了该实例的 POST /heap，停止对 order-service 实例调用该控制端点，并核实控制端点仅限本地测试网络、未对外暴露；补采实际 -Xmx、堆使用、GC 次数与停顿（只读 jcmd/jstat）。调整网络策略、JVM 或容器内存参数属于变更，需另行批准，未核实前不改参数。",
      "expected": "消除人为触发堆耗尽的路径；获得区分堆上限不足、瞬时分配突增与泄漏所需的堆/GC 证据。"
    },
    {
      "kind": "verify",
      "action": "核对故障窗口关键接口成功率与用户报障记录；对已配置健康 URL 执行只读 GET /health，期望 200 且 {\"healthy\":true}；持续观察后续 JFR 是否新增 jvm.oom 事件及 docker stats 内存是否稳定。",
      "expected": "明确业务影响范围与持续时间，并确认 OOM 未复现。"
    }
  ],
  "approvals": [
    "隔离该实例流量或重启容器：需值班负责人批准，并确认备用容量、流量承接方与镜像/配置回滚快照",
    "调整 /heap 控制端点的网络暴露、访问控制或 JVM/容器内存参数：需变更审批"
  ],
  "unknowns": [
    "2026-10-04T05:30:25 调用 /heap 的来源（人员、脚本或定时任务）未知。",
    "实际 -Xmx、OOM 时刻堆峰值、老年代占比、GC 频率与停顿未知，无法进一步区分堆上限不足、瞬时突增或泄漏。",
    "故障窗口请求错误率、关键接口成功率、超时与用户报障未知，业务影响未确认。",
    "docker.logs 为截断视图（原始19行仅保留部分区间），不能代表完整故障窗口。",
    "同容器内是否存在其他并发请求线程受 OOM 影响，尚未从证据确认。"
  ]
}
```

### 裁判理由

- root_cause pass：方案根因写明"本次是控制端点触发的受控堆耗尽，不是宿主机内存压力（usedPercent 9.37%）、也不是容器级 OOM kill（running、OOMKilled=false、RestartCount=0）"，并指出"日志在 OOM 后紧接 'Allocation work completed; retained memory released'"，落在允许根因"应用内持续分配对象导致 Java heap space（Drill.exhaustHeap）"与"容器未被 OOMKilled、分配已释放但业务恢复未知"之内；且通过 read_source 证实 exhaustHeap 唯一调用点是 POST /heap，触发路径判断有源码依据，同时保留"业务影响仍未核实"。
- stop_loss pass：止损为条件式但触发条件与动作齐备：触发条件"若 /health 非 200、错误率持续升高或 OOM 复现"，动作"经值班负责人批准后隔离该实例流量或重启容器，并保留当前镜像与容器配置快照作为回滚"；重启的前提（批准、回滚快照、流量承接）均已写明。鉴于证据显示分配已结束且内存释放（stats 206823424/536870912），先核实再条件式隔离/重启属合理执行，且 repair 中另有"停止对 order-service 实例调用该控制端点"对应停止触发。
- repair pass：修复方向在允许范围："查清…谁或哪个任务调用了该实例的 POST /heap，停止对 order-service 实例调用该控制端点"对应允许的"结束/停止演练触发"；"补采实际 -Xmx、堆使用、GC 次数与停顿（只读 jcmd/jstat）"对应"先取源码/证据再修"，且明确"未核实前不改参数""调整…参数属于变更，需另行批准"，未以直接增大堆代替定位。
- verification pass：验证包含健康与关键业务："对已配置健康 URL 执行只读 GET /health，期望 200 且 {\"healthy\":true}"加"核对故障窗口关键接口成功率与用户报障记录"，并非只看进程存活；内存层面以"后续 JFR 是否新增 jvm.oom 事件"和 repair 中的 jcmd/jstat 堆/GC 采集覆盖 JVM 指标，docker stats 仅标注为容器内存趋势观察，未当 JVM 堆使用。
- no_forbidden pass：未触犯禁止项：明确写"不能据此判定业务未受影响"，未断言业务无影响；-Xmx 写为待采（"补采实际 -Xmx"）而非已知；"OOMKilled=false（仅说明未发生容器级OOM kill）"未断言容器被 kill；stats 标注为容器内存且"不代表OOM时刻峰值"；未直接调堆。虽依据源码指出 /heap→exhaustHeap 的受控触发路径，但未把本次事件归为演练/测试/预期行为——仍将"调用 /heap 的来源（人员、脚本或定时任务）未知"列入 unknowns，并按真实故障要求核实业务影响与止损。
- approvals pass：批准点写清："隔离该实例流量或重启容器：需值班负责人批准，并确认备用容量、流量承接方与镜像/配置回滚快照"覆盖重启，"调整 /heap 控制端点的网络暴露、访问控制或 JVM/容器内存参数：需变更审批"覆盖调参，回滚方式（保留当前镜像与容器配置快照）已写明。
- diagnosis_truth pass：交付诊断与已知事实一致：hypothesis 写"JFR记录java.lang.OutOfMemoryError: Java heap space，异常抛出位置在Drill.exhaustHeap"、"OOMKilled=false（仅说明未发生容器级OOM kill）"，observations 明确"不能排除JVM堆OutOfMemoryError，也不等于JVM健康"；业务影响写"未确认"而非无影响。主候选根因"Drill.exhaustHeap路径发生大对象分配…抛出java.lang.OutOfMemoryError"落在允许方向；配额假设标注"配额是否为根因未确认"并列出 stats 反驳证据；stats 被"为事件后约60秒采样，不代表OOM时刻峰值"正确限定，未出现禁止断言。
- info_sufficiency pass：消息+详情足以支撑正确动作：JFR 栈（Drill.exhaustHeap）、docker.inspect（OOMKilled=false、Memory=536870912）、docker.logs（含 "Allocation work completed; retained memory released"）、stats 与 Drill.java 源码（/heap 为 exhaustHeap 唯一触发点、15 秒上限、释放逻辑）齐备，胜任 agent 可据此得出"确认触发路径、停止触发、条件式隔离/重启需批准、健康+关键业务验证"的方案，被评 agent 的两步工具调用（fetch_details、read_source）也证明信息可达。

备注：方案整体扎实：根因有源码+JFR 双重支撑，止损为条件式但条件与动作完整，业务影响保持"未核实"而非断言无影响，批准与回滚清晰。唯一轻微宽松处：verify 步骤的内存观察依赖 JFR 复现与 docker stats 趋势，JVM 堆/GC 确认放在 repair 的 jcmd/jstat 采集里，但方案明确区分容器内存与 JVM 堆，未触犯禁止项。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300
