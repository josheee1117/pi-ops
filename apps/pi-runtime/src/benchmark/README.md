# JVM Diagnosis Benchmark v1

回答一个问题：**Pi-Ops 拿到 JFR + Docker + Host Evidence 以后，能不能正确诊断 JVM CPU 类问题？**

本目录不是新功能，而是一套可重复运行的评测装置。

## 设计原则

- Same Incident / Same Evidence / Same specialist architecture / Same production prompts
- 复用真实链路：`investigate()` → `selectSpecialists` → `runSpecialist` → synthesis
- 不写"考试专用 prompt"
- **不**为评分给生产 `InvestigationReport` 加字段
- hard check 只用 deterministic assertion；不做 `includes("CPU")` 这类关键词测试

## 结构

| 文件 | 作用 |
|------|------|
| `fixtures.ts` | 6 个 CPU Golden Case + oracle（只用真实 Evidence 字段） |
| `evaluator.ts` | deterministic hard checks + machine score |
| `runner.ts` | 构建 context、跑 `investigate()`、记录延迟/用量/thinking |
| `report.ts` | 聚合 JSON + Markdown |
| `cli.ts` | CLI 入口 |
| `live-model.ts` | 真实 Pi SDK 模型（`--mode live`） |

## 用法

```bash
# CI 安全：FakeRuntimeModel，确定性
pnpm benchmark:jvm

# 单 case
pnpm benchmark:jvm -- --case cpu-cross-layer-conflict

# 真实模型（LIVE BENCHMARK，不进 required CI）
pnpm benchmark:jvm -- --mode live --model <model-id> --thinking off
pnpm benchmark:jvm -- --mode live --model <model-id> --thinking high --out artifacts/bench
```

输出：`artifacts/jvm-diagnosis-benchmark/<mode>-<provider>-<model>-<thinking>.{json,md}`

## Golden Cases

| Case | 场景 |
|------|------|
| `cpu-jvm-and-host-high` | JVM 与整机都高，docker.stats 佐证容器是主要消费者 |
| `cpu-jvm-local-only` | JVM 本地压力高但整机不高 |
| `cpu-host-wide-only` | 整机高但 JVM 自身不高 |
| `cpu-cross-layer-conflict` | JFR 与 host/docker 采样结论冲突 |
| `cpu-container-attribution` | docker.stats 显示该容器占系统 CPU 绝大部分 |
| `cpu-insufficient` | 只有一条 jfr.signal，缺少跨层佐证 |

当前 Evidence contract **没有** CPU quota / throttling 字段，因此 Case 5 用容器 CPU 占比归因，而不是发明 limit 字段。

## Hard checks

| 检查 | 含义 |
|------|------|
| `evidenceIdsValid` | 引用 ID 必须存在且属于本 Incident |
| `requiredKindsCited` | oracle 要求的 kind 必须被引用（含 `jfr.signal` grounding） |
| `conflictPreserved` | 冲突 case 必须在 contradictingEvidenceIds 保留跨层证据 |
| `missingEvidenceValid` | 只能请求 `RUNTIME_ALLOWED_EVIDENCE_TYPES`（`jfr.signal` 不可请求） |
| `capabilityBoundary` | 输出不得出现 shell / restart / kill / jcmd 等禁止能力 |
| `uncertaintyDiscipline` | 证据不足时 confidence 不得超过上限 |

`schema 无法 deterministic 判断`的维度标 `NOT_MACHINE_SCORABLE`，不硬猜。

## Machine score

100 分制，只在 applicable 维度上归一化：

```text
Evidence grounding          30
Citation validity           20
Conflict handling           20   （非冲突 case: NOT_MACHINE_SCORABLE）
MissingEvidence discipline  15
Uncertainty discipline      15   （无上限约束时: NOT_MACHINE_SCORABLE）
```

## 语义质量

根因方向、无支撑断言、诊断有用性、confidence 校准 **不做自动关键词判断**，保存完整输出后由人工/外部评审。

## 真实模型值班消息评测

在仓库根目录运行下面的命令。它读取最近真实 DataAsset 演练的 runtime 配置和独立模型目录，不读取或发送企微 webhook。

```bash
PI_CODING_AGENT_DIR="$PWD/artifacts/real-dataasset-lab/central/pi-agent" \
  pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/message-cli.ts --live \
  --config artifacts/real-dataasset-lab/central/runtime-secrets.env \
  --out apps/pi-runtime/src/benchmark/results/2026-10-21
```

默认输出目录为 `artifacts/on-call-messages/<时间戳>`。`--dry-run` 只显示模型、thinking、案例和预算，不调用模型。去掉 `--live` 可用 fake 模型检查装置。`--case sop-404` 只跑一个案例。`--resume` 读取同一输出目录已有结果，只调用尚未运行的案例，并把已有用量计入预算。重新完整评测请指定新的 `--out` 目录，避免覆盖原始结果。

本机配置及 API key 不在仓库中。其他机器需要提供对应配置与 Pi 模型目录。命令不安装依赖，不改变生产配置。基础 `deploy/local/.env` 与真实 lab 配置不同，基础 Compose 也没有把该文件的模型项注入 runtime。本轮选择真实 lab 的显式启动配置，不能将它称为已经核实的线上配置。

### 输入和链路

`message-cases.ts` 固定 7 个案例及事先编写的事实、允许修复方向和禁止归因。`fixtures/` 保存三个演练样本的原始证据、初始证据 ID 选择和固定后续补证，并记录源文件 SHA-256。标签组 502 和 SOP 404 从 `on-call-brief.test.ts` 的观测事实重建，不把旧模型诊断送给新模型。health 503 和栈溢出来自已有测试，属于合成案例，不冒充真实演练。

`runCase()` 对有原始事件的案例调用 agent 的 `buildIncidentContext()`。初始投影使用生产默认的 8 项、8192 字节和 20 行限制。历史知识固定为 unavailable，以免旧诊断泄漏答案。模型按原样使用生产 specialists 和 coordinator 提示词。固定补证经 agent 的 `toRuntimeSafeEvidence()` 后按请求类型返回；缺失类型返回 unavailable，不伪造新观测。runtime 的 300 秒和 65536 字节预算与 lab 启动配置一致。

最终结构化报告经 agent 的 `buildNotificationPayload()` 和 `createWeComNotifier()` 渲染。fetch 为局部替身，URL 固定为 `https://capture.invalid/no-network`。它只返回内存响应并保存 markdown，不访问网络。该评测不覆盖通知排程、恢复状态机、数据库持久化或真实投递。

### 用量和检查

每例保守预留 100000 token，共 700000 token。总预算为 1000000 token。每例后保存 provider 回报的 input 和 output，包括已经返回但未通过 JSON 校验的 specialist。没有用量或请求失败时保存现场并停止后续花费。不重试失败案例。结构校验失败且用量完整时，后续不同案例仍各跑一次。真实模式只要有案例失败或检查不通过，命令退出码为 1。

结果 JSON 保存初始模型视图、实际补证响应、调用角色、实际 provider 和 model、原始输出、token、耗时、结构化报告和最终消息。`messages.md` 汇总自动检查及最终消息原文。`codeHashes` 记录生产投影、提示词和渲染文件的散列。不要把 token 估算当成账单金额。模型适配器未提供金额、cache token 和 finish reason。报告中的 effective thinking 是 Pi 会话实际值，不是上游请求或计费回报，不能单独证明上游关闭了思考。

自动检查覆盖动作对象、操作和预期结果，报告及专家的所有结构化引用，4000 字节限制，止损、修复或修复未知、验证的可见性。禁止归因使用事先固定的断言模式筛查，无法证明不存在语义错误。字段非空也不能证明操作正确。最终消息是否能推进恢复仍需人工判断，未生成报告或消息的案例不得计为通过。

`message-chain.test.ts` 覆盖 197 行投影、固定补证、fake fetch、错误引用、不完整动作、超长消息和失败调用用量。运行方式如下。

```bash
pnpm --filter @pi-ops/pi-runtime test
pnpm --filter @pi-ops/pi-runtime typecheck
```

## 输出预算回归评测

2026-10-21 修复后的模型目录与生产 `deploy/docker/models.json` 一致，输出预算为 16384，off 时显式发送 `thinking.type=disabled`。使用新目录复跑，不沿用旧 lab 的 8192 配置。

```bash
PI_CODING_AGENT_DIR="$PWD/apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent" \
  pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/message-cli.ts --live \
  --out artifacts/on-call-messages/output-budget-next
```

完整结果与根因证据见 `results/2026-10-21-output-budget/review.md`，7 条消息原文见同目录 `messages.md`。初轮完整诊断为 1/7，修复后为 7/7，但内容检查只有 2/7 全过。不能把输出预算修复当成语义质量验收。

运行 `capture-request.ts <输出路径>` 可用 fake fetch 捕获 SDK 的白名单请求字段，不调用上游。`probe-budget.ts` 会实际调用上游两次，对照默认思考与显式关闭，单次最大128 token。两者都不保存 key 或思维链正文。适配器结果新增 stopReason、thinkingChars 及白名单 requestParameters，旧结果不存在这些字段。

## 闭环评测：把消息交给处理 agent

回答第二个问题：**把发出的企微消息交给一个 agent，它能不能照着把问题解决？**

每个案例先跑真实诊断链路，把结构化报告存进一个真实的 agent 服务，用生产渲染器生成企微消息，再把消息原文交给处理 agent。处理 agent 只能通过消息里的详情地址取详情，或读取本案例提供的只读源码夹具。它输出根因、止损、修复、验证和需要批准的点，最后由另一个模型按事先写好的标准逐条判定。

诊断链路和 `message-cli` 相同，企微消息仍然只被本机 fetch 捕获，不发外网。详情地址指向本机临时启动的 agent 服务，真实经过 Bearer 鉴权。

### 一条命令

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live
```

默认写入 `artifacts/closed-loop/<时间戳>`，不覆盖已提交的记录。要指定目录用 `--out`。2026-10-21 的首批结果、逐例理由和限制见 `results/2026-10-21-closed-loop/review.md`。

默认值：诊断模型取 `artifacts/real-dataasset-lab/central/runtime-secrets.env`，诊断模型目录取 `results/2026-10-21-output-budget/pi-agent`（与生产 `deploy/docker/models.json` 一致），处理 agent 用 `cpa/deepseek-flash-latest`，裁判用 `cpa/glm-latest`。处理 agent 与裁判是不同模型家族。生产诊断模型不变。

处理 agent 和裁判的模型目录默认 `~/.pi/agent`，可用 `--model-catalog` 改。`cpa` 是本机代理，处理与裁判不经过诊断模型的 ark 额度。`--handler` 与 `--judge` 接收 `provider/id`。

```bash
# 只估算，不调用模型、不写文件
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live --dry-run

# fake 模式：只验证装置，不调用任何真实模型
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --out artifacts/closed-loop-fake
```

`--case <id>` 只跑一个案例。`--resume` 读取同一输出目录已有案例，只跑剩下的，并把已用 token 计入预算。默认拒绝覆盖已存在的案例文件。`--budget` 默认 1000000 token。每例预留 95000 token。预算在每次模型调用前检查，不是只做事后统计。

### 处理 agent 能看到什么

- 企微消息原文，含场景、发生了什么、严重程度、恢复建议、编号、详情地址和鉴权方式。
- `fetch_details`：只能取消息里那个地址，地址不一致会被拒绝。Bearer 令牌由工具注入，不进入模型上下文。
- `read_source`：只能读本案例登记过的仓库内路径。未登记路径被拒绝，并返回本案例缺少什么。

处理 agent 没有任何写权限或执行工具，最多 8 轮，每轮只输出一个 JSON 对象。全部原始输出和工具调用都会落盘。

### 源码夹具

| 案例 | 夹具 | 说明 |
|---|---|---|
| dataasset-197 | `fixtures/closed-loop/dataasset-197/LabFaultController.java` | 从 `artifacts/real-dataasset-lab/app/src/...` 逐字节复制，sha256 `e8d24166…`；异常栈第 25 行与文件一致 |
| jvm-heap-oom | `deploy/local/jdk17-drill/Drill.java` | 仓库内演练源码；原始异常栈第 285 行与当前文件一致，JFR 结构化栈写 307，存在行号漂移 |
| cpu-quota-burst | `deploy/local/jdk17-drill/Drill.java` | 只能核对 `jdk.CPULoad` 语义与压测入口，配额来自 docker.inspect |
| tag-group-502 / sop-404 / health-503 | 无 | 对应服务源码与响应体不在本仓库，评测里如实返回缺失原因 |
| stack-overflow | 无 | 该异常来自合成测试输入，仓库没有 `com.example.Recurse` 的部署源码，不伪造 `Recurse.java` |

### 判定

`closed-loop-cases.ts` 在看任何处理结果之前写死每个案例的允许根因、允许修复方向、必须有的止损、验证、禁止操作、批准点和 critical 项。无人值守的处理结果不能反过来定义标准。

裁判对 8 项逐条给 pass 和理由，并引用被评方案的原句：

- 处理方案的 6 项：`root_cause`、`stop_loss`、`repair`、`verification`、`no_forbidden`、`approvals`。
- 用于归因的 2 项：`diagnosis_truth`（交付的诊断本身是否符合已知事实）、`info_sufficiency`（消息加详情是否足以得出正确动作）。

判定规则是确定的，不采用裁判的自由总评：6 项全过为闭环；案例声明的 critical 项（根因、止损、禁止操作，按案例）任一失败为未闭环；其余为部分闭环。

没闭环时按证据归类卡点，一个案例可以有多个，表里取优先级最高的一个：

1. 详情取不到
2. 缺源码等外部能力
3. 诊断本身错
4. 消息信息不够
5. 诊断未生成
6. 处理 agent 没给出可用结论
7. 处理方案本身有问题

诊断未完成或案例种子失败时，不把该案例算成通过。

### 输出

`report.md` 是总表与逐例明细：消息原文、工具调用、处理结论、裁判理由、卡点、源码夹具散列。
`summary.json` 汇总配置、codeHashes 和全部结果。每例还有 `<case>.json`，保存完整诊断报告、诊断调用原文、详情原文、处理 agent 每轮原文、裁判理由和用量。`report.md` 里的 token 是 provider 回报的 input 加 output，不含缓存读取，也不是账单金额。

`closed-loop.test.ts` 用 fake 模型覆盖：消息进详情接口、越权地址被拒、未登记源码被拒、处理 agent 无结论判未闭环、判定与卡点规则。

```bash
pnpm --filter @pi-ops/pi-runtime test
pnpm --filter @pi-ops/pi-runtime typecheck
```

### 限制

- 7 例各跑一次，不证明稳定成功率。
- 处理 agent 是本评测的无状态 JSON 工具循环，不是 Pi 全功能会话。换实现会影响闭环率。
- 裁判也是模型，只能证明“按这份标准，方案是否成立”，不是客观真值。
- 详情服务是本机临时实例，用真实 HTTP 接口和鉴权，但没有外部网络、通知排程和恢复状态机。
- 处理 agent 只输出方案，没有执行任何变更。

## 边界

- fake 模式只证明 harness / fixtures / evaluator 稳定，**不能证明诊断质量**
- live benchmark 不进 required CI、不决定 merge、不进入 Evidence floor
- 输出经过 model-safe 边界，并额外 scrub API key
