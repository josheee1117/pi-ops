# 处理须知与人话消息检查

## 结论

本轮只完整重跑 CPU 和 OOM 两例。固定裁判判为 2/2 closed，每例 8 项全过。第 18 单中 CPU 为 open，OOM 为 closed。CPU 不再把本次定为演练误报。OOM 不再写“演练型堆耗尽”，但仍写“受控堆耗尽”，这个词存在暗示计划内行为的风险，不能把裁判通过当作风险完全消失。

消息离线重评没有调用模型。两批共 14 例的短消息格式合同全过，但 messageHardPass 仅 2/14。11 例缺少 repair 动作及明确修复未知说明，另 1 例缺少 mitigation 动作。检查不再要求短消息包含旧标签，也没有把实质动作要求放宽。

## 改动

- `apps/agent/src/incident-brief.ts` 在详情的处理顺序中增加通用证据边界。名称和源码注入能力不能证明本次是演练、误报或预期行为。无证据时按真实故障处理，业务影响未知时先核实。
- `apps/agent/src/__tests__/incident-brief.test.ts` 通过真实 HTTP 摄取事件、回调诊断、重开磁盘 SQLite 后读取鉴权详情，断言须知可见。
- `docs/agent-handle-alert.md` 同步规则。
- `apps/pi-runtime/src/benchmark/evaluator.ts` 使用已有 summary schema 检查摘要及实际消息的 1 至 3 条编号建议。保留详情地址、Bearer、4000 字节上限及禁止详细段落检查。止损和验证从 diagnosis.actions 读取。修复要求 repair 动作，或消息、recommendation、uncertainties 明确说明修复尚未确定。
- `apps/pi-runtime/src/benchmark/message-chain.test.ts` 新增真实自由文本消息、缺止损反例、修复未知、缺验证、摘要不合法、建议数量及长度、编号、鉴权、详细段落和消息超长检查。默认 fake 诊断没有验证动作，因此其短消息格式通过但整体检查失败，测试不再把它误报为完整动作通过。
- `apps/pi-runtime/src/benchmark/report.ts` 说明短消息与详情动作分别检查。
- 本目录保存两例原始结果、合并报告、离线重评脚本及 JSON、验证日志和本说明。旧结果没有覆盖。

`closed-loop-agent.ts` 的 HANDLER_SYSTEM、裁判标准、`closed-loop-cases.ts` 和 `specialists.ts` 均未修改。本任务没有发企微，没有启动 compose 栈，没有修改或提交其他会话的验证技能、README 或 smoke 文件。

## 模型、预算与运行方式

诊断仍为 `ark/deepseek-v4.1-flash`，处理仍为 `cpa/deepseek-flash-latest`，裁判仍为 `cpa/glm-latest`，三者 thinking 均为 off。`cmp deploy/docker/models.json apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent/models.json` 返回 0。

| 案例 | 调用前剩余额度 | 本例 token | 累计 token | 耗时 ms |
|---|---:|---:|---:|---:|
| cpu-quota-burst | 250000 | 72395 | 72395 | 246351 |
| jvm-heap-oom | 177605 | 68316 | 140711 | 222127 |

每例先运行同配置的 `--dry-run`，估算为 95000 token，均通过预算门槛。实际调用没有 429，没有重跑或重判。

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --case cpu-quota-burst --budget 250000 --dry-run \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r2
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --case cpu-quota-burst --budget 250000 \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r2
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --case jvm-heap-oom --budget 177605 --dry-run \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r2
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --case jvm-heap-oom --budget 177605 \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r2
```

每次都重新调用诊断、处理和裁判模型。装置运行真实本机 HTTP agent，使用临时磁盘 SQLite，处理 agent 实际取鉴权详情并读源码。夹具事件与证据直接写入 store，通知由 fake fetch 捕获，所以这不是故障产生和采证的真实演练，也不证明执行修复后业务恢复。单例 CLI 会覆盖汇总，结束后以两份原始案例 JSON 合并 summary.json，并用现有 renderClosedLoopReport 生成 report.md。

## 与第 18 单逐例比较

| 案例 | 第 18 单 | 本轮 | 裁判通过 | reportHardPass | messageHardPass |
|---|---|---|---|---|---|
| cpu-quota-burst | open | closed | 8/8 | true | false |
| jvm-heap-oom | closed | closed | 8/8 | true | false |

两例诊断都未降级。本轮两个 messageHardPass=false 均因诊断没有 repair 动作，也未明确写修复尚未确定，不是因为自由文本缺标签。闭环判定和消息自动检查是不同检查，不能混报为全部通过。

### CPU 处理回答原文

第 18 单 `../2026-10-22-closed-loop/cpu-quota-burst.json` 的 `result.handler.answer.rootCause` 写：

> 证据更支持“容器启动初期短时CPU开销 + 演练阈值配置过低导致的单点告警”，而非持续CPU压力或业务故障。

本轮 `cpu-quota-burst.json` 的同一字段写：

> 现有证据只能支持“容器内 JVM 用户态 CPU 短时接近自身 2 核配额”，不能确认业务影响，也不能确认具体触发代码路径。

> 容器名含 drill、镜像名为 jdk17-drill 均不构成演练或误报的证明，本结论按真实告警处理；OOMKilled=false 也不能排除 JVM 堆 OOM（本次未见 MemoryFailure/jvm.oom 事件）。

`unknowns` 还写：

> 业务影响仍未确认：无请求错误率、关键接口结果、用户报障与真实 /health 探测结果

处理回答仍将 CPU_THRESHOLD 可能下调列为待核实假设，但未据此定性误报。它正确换算 0.194×10≈1.94 核并对照 2 核配额。固定裁判的 no_forbidden 明确认可其演练与影响表述。

### OOM 处理回答原文

第 18 单 `../2026-10-22-closed-loop/jvm-heap-oom.json` 的 `result.handler.answer.rootCause` 写：

> 源码与证据一致地指向“自触发、可自愈的演练型堆耗尽”，不是生产堆泄漏或堆参数过小。

本轮 `jvm-heap-oom.json` 的同一字段写：

> 因此本次是控制端点触发的受控堆耗尽，不是宿主机内存压力（usedPercent 9.37%）、也不是容器级 OOM kill（running、OOMKilled=false、RestartCount=0）；事件后约60秒 stats 显示容器内存 206823424/536870912，无泄漏证据。但 OOM 期间是否影响在途业务请求、错误率与用户报障仍未核实，不能据此判定业务未受影响。

`unknowns` 写：

> 2026-10-04T05:30:25 调用 /heap 的来源（人员、脚本或定时任务）未知。

> 故障窗口请求错误率、关键接口成功率、超时与用户报障未知，业务影响未确认。

源码唯一调用链及释放日志可以支持控制端点路径，但不证明本次获授权或是计划内演练。“受控”仍可能让读者误解为预期行为。固定裁判 no_forbidden 接受了该回答，理由是它保留调用来源未知，并按真实故障要求确认影响与止损。此处保留裁判原判，报告剩余措辞风险，不重判到满意。

## 14 例离线重评

运行命令只读取保存结果，不调用模型：

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx \
  src/benchmark/results/2026-10-22-closed-loop-r2/message-recheck.ts
```

`message-recheck.json` 保存每项检查和失败说明。脚本从原详情提取证据，从保存模型输出取每个专家最后一个通过 schema 的结果，使用当前 evaluateMessage 重算。14 例原 messageHardPass 均为 false。短消息合同五项在新检查下全部通过。

| 案例 | 10-21 新 messageHardPass | 原因 | 10-22 新 messageHardPass | 原因 |
|---|---|---|---|---|
| dataasset-197 | false | repairOrUnknown | false | repairOrUnknown |
| jvm-heap-oom | false | repairOrUnknown | false | repairOrUnknown |
| cpu-quota-burst | false | repairOrUnknown | false | repairOrUnknown |
| tag-group-502 | false | repairOrUnknown | false | repairOrUnknown |
| sop-404 | false | repairOrUnknown | false | mitigationInDiagnosis |
| health-503 | false | repairOrUnknown | false | repairOrUnknown |
| stack-overflow | true | 无 | true | 无 |

repairOrUnknown 失败表示既无 purpose=repair 动作，也未明确说明修复尚未确定。缺源码、先补证或“触发逻辑未知”不自动等价于修复未知。mitigationInDiagnosis 失败表示动作没有 purpose=mitigation。服务不可用类必须具备止损动作，消息上的建议不能抵消详情缺项。

## 验证

测试先提交为 `a4dbffe`，修复提交为 `0ee7644`。失败及通过输出节选在 repro.log，全量命令输出在 verification.log。

改前真实格式消息的断言原文：

```text
mitigationVisible: fail
repairOrUnknownVisible: fail
verificationVisible: fail
false !== true
```

改后相同真实消息通过，删掉 diagnosis.actions 中止损动作后仍失败，即便消息额外写“止损：经批准隔离流量”。HTTP 详情测试改前因缺须知失败，改后通过。

| 命令 | 结果 |
|---|---|
| `pnpm --filter @pi-ops/pi-runtime exec tsx --test src/benchmark/message-chain.test.ts` | 8/8 通过 |
| `pnpm --filter @pi-ops/agent exec tsx --test src/__tests__/incident-brief.test.ts` | 1/1 通过，真实 HTTP 与磁盘 SQLite |
| `pnpm --filter @pi-ops/pi-runtime test` | 92 项，91 通过，1 个原有可选 SDK smoke 跳过，0 失败 |
| `pnpm --filter @pi-ops/pi-runtime typecheck` | 通过 |
| `pnpm --filter @pi-ops/agent test` | 403/403 通过 |
| `pnpm --filter @pi-ops/agent typecheck` | 通过 |
| `git diff --check` | 通过 |

## 新坑 / 决定

1. 人话格式通过不代表动作完整。证据为 message-recheck.json，14 例短消息合同全过，但仅 2 例整体通过。决定保留 11 个修复说明缺项和 1 个止损缺项，不把补证自动当作修复未知。
2. OOM 的“受控堆耗尽”仍有误导风险。证据为 jvm-heap-oom.json 的 rootCause、unknowns 和 no_forbidden。决定原样保留 closed，明确它不证明计划内演练，规则不能保证模型每次措辞都正确。
3. 新重跑两例的诊断仍缺 repair 或明确未知说明。证据为两份案例的 diagnosis.report.diagnosis.actions 与 diagnosis.messageHardPass=false。决定不改本任务禁止修改的诊断提示词。
4. 默认 fake 诊断没有验证动作，旧测试依靠模板里的“验证：”得到通过。证据为 message-chain.test.ts 的七例 fake 路径与现有 coordinator.ts。决定分别断言短消息合同通过、整体动作检查失败，不改范围外 fake 诊断。
5. 离线脚本首次 typecheck 遇到 TS2345，因为 evidenceSchema 的 data 与 status 推导为可选，而 BenchmarkEvidence 要求必填。决定显式保留 data 并检查 status 后收窄，最终 typecheck 通过，未用类型强转。
6. SDK 在旧模型目录生成 auth.json。证据为 git status 的未跟踪路径 `../2026-10-21-output-budget/pi-agent/auth.json`。没有读取或提交它。其他会话修改验证技能和 smoke，均未纳入本任务提交。
