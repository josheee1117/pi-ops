# 收紧裁判与降级检查（2026-10-21）

## 结论

旧标准 7/7 闭环，新标准 5/7 闭环。CPU 配额和 JVM 堆 OOM 两例从闭环变为未闭环，原因是没有证据就把本次事件归为演练、预期行为，并断言业务未受影响。DataAsset 保持闭环，因为源码写明故障注入，属于有证据。其余 4 例维持闭环。

这次只重跑裁判，没有重新生成诊断，也没有重跑处理 agent。消息、诊断、处理回答全部来自 `results/2026-10-21-closed-loop/`，源目录未改动。

## 运行

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --rejudge \
  apps/pi-runtime/src/benchmark/results/2026-10-21-closed-loop \
  --out apps/pi-runtime/src/benchmark/results/2026-10-21-closed-loop-rejudge
```

- 裁判：`cpa/glm-latest`，thinking off。
- 成功这轮回报 token 108932，耗时 789 秒，预算 200000。
- 第一次尝试在中途中断：裁判对 `tag-group-502` 返回了非 JSON，命令退出。已回滚那 3 例结果，并给裁判加了一次有界重试，错误信息保留原始输出前 1500 字。第一次尝试 3 例共 67378 token。本轮合计 176310 token，低于 200000。
- 第一次尝试的规则还没有“写成更像 / 倾向于也算断言”这一句，OOM 只降到部分闭环。补上这句后 7 例全部重判，得到下面的最终结果。

## 新旧对比

| 案例 | 旧判定 | 新判定 | 变化项 | 新卡点 | token |
|---|---|---|---|---|---|
| dataasset-197 | closed | closed | 无 | 无 | 16172 |
| jvm-heap-oom | closed | open | verification、no_forbidden | 处理方案本身有问题 | 28138 |
| cpu-quota-burst | closed | open | root_cause、no_forbidden | 处理方案本身有问题 | 27801 |
| tag-group-502 | closed | closed | 无 | 无 | 8711 |
| sop-404 | closed | closed | 无 | 无 | 11191 |
| health-503 | closed | closed | 无 | 无 | 7563 |
| stack-overflow | closed | closed | 无 | 无 | 9356 |

## CPU 配额：新的裁判理由

`no_forbidden`：

> 方案多处违反禁止断言：rootCause 断言“业务并未发生故障”、“判定为已自行结束的短时压测负载”、“该告警是按配置阈值真实触发，不是 JVM 或业务缺陷”，把本次事件定性为压测/预期行为。方案可引用的证据只有容器名带 drill/演练、Drill.java 具备 /cpu 压测能力，标准明确这些“都不足以证明本次事件是预期演练”，且方案自认无请求审计；“业务未受影响”也无真实业务指标支撑（unknowns 承认只有演练健康端点作间接证据）。其余禁项（机器 ratio 当配额利用率、声称整机饱和、未批准变更）均未触犯，方案还特意写明“非 2 核配额的 19.4%”。

`root_cause`：

> 方案根因写的是“这是本地演练容器……上一次有上限的 CPU 压测造成的单次告警，业务并未发生故障”，把事件直接归因于压测/演练负载并断言业务无故障。允许的根因方向只有“容器 2 核配额、故障期约 1.91 核接近上限、可能存在 throttling”或“机器 10 核未饱和、热点与业务影响未知”，两者都要求保持热点与业务影响未知；且方案自己在 unknowns 里承认“缺少请求审计：无证据直接证明本次是外部 POST /cpu 触发……属高置信推断”，推断不能作为根因结论。

## JVM 堆 OOM：新的裁判理由

`no_forbidden`：

> rootCause 写有“该实例是 local-dev 的本地演练实例，日志明确提示……因此当前更像演练触发后的预期失败”。按标准，“更像/倾向于/可能是”式地把本次事件归为预期演练也算断言，而环境/服务名带“演练”、源码具备注入端点能力、日志出现释放字样均不足以作为本次事件是预期演练的证据，Drill.java 源码并无类似 DataAsset 的明确故障注入声明；其余禁止项（断言 OOM kill、声称已知 Xmx、docker.stats 当堆、直接加大堆、断言业务无影响）均已避开。

`verification`：

> verify 动作仅为“观察连续 JFR 事件与 docker.stats，执行 GET /health……确认无新 jvm.oom、容器 running、RestartCount 不增长；仅在低峰且具备回滚条件时，经批准后再做受控复现”：关键业务请求验证只是条件性可选项，未列为必做步骤；且内存回落仅靠 docker.stats（容器内存）与 JFR 事件观察，未按标准要求用 JVM 堆/GC 指标确认回落，验证手段不完整。

OOM 的 verification 失败与新增禁止项无关，是另一次裁判对同一回答的重新判断。旧裁判判 pass，新裁判判 fail。它说明单项判定仍有模型波动，但两例的关闭都同时有禁止项失败，不依赖这一项。

## DataAsset 为什么仍闭环

同一套规则下，裁判明确引用了源码：

> “异常是预期注入”一语有据：docker.logs 异常文本 “Real DataAsset lab fault injection” 与源码夹具 LabFaultController.java 第 25 行硬编码字符串完全一致，标准明确“DataAsset 源码写明故障注入，属于有证据”。“尚无服务不可用或关键业务受影响事实”是对证据缺失的表述，且 unknowns 中写明“其他业务接口是否受影响尚未通过关键业务请求验证”，未做出无据的“业务未受影响/无影响”断言。

其余 4 例（标签组 502、SOP 404、health 503、栈溢出）没有把事件归为演练或预期行为，也没有无证据断言业务无影响，新规则下判定不变。

## 降级诊断检查

`evaluator.ts` 新增 `diagnosisComplete` 硬检查。它只读生产标记：`hypothesis` 或 `recommendation` 以“诊断不完整”开头时判 fail，`degraded` 为 true，`evaluation.hardPass` 和 `messageEvaluation.hardPass` 随之为 false。报告表分别显示“诊断降级”和“未通过（诊断降级）”，闭环报告显示 `completed（降级）`。

生产代码 `structured-output.ts`、`coordinator.ts` 未改。降级标记仍由生产生成，评测只读。

本批 7 例的诊断都不是降级产物，所以重判没有因此变化。本机冒烟里的降级消息（`artifacts/closed-loop-smoke/report.md:26`）在新的检查下会判 fail，但那份产物没有进仓库。

## 验证

先失败后通过：

1. 新测试先跑，报 `TypeError: Cannot read properties of undefined (reading 'status')`，因为 `diagnosisComplete` 还不存在。
2. 加检查后同一测试通过，并覆盖两份报告表的降级标记。

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx --test src/benchmark/degraded-diagnosis.test.ts
pnpm --filter @pi-ops/pi-runtime exec tsx --test src/benchmark/closed-loop.test.ts
pnpm --filter @pi-ops/pi-runtime test
pnpm --filter @pi-ops/pi-runtime typecheck
```

- `degraded-diagnosis.test.ts` 1 项通过。
- `closed-loop.test.ts` 5 项通过，包含重判只读源目录、裁判非 JSON 重试一次。
- 全量 87 项，86 通过，1 跳过（原有 `pi-session.smoke.test.ts` 需要环境变量），0 失败。
- `typecheck` 通过。

## 边界

- 裁判仍是模型，只证明“按这份标准，方案是否成立”。7 例各重判一次，不证明稳定。
- 新规则依赖裁判判断“有没有证据”，不是确定性检查。DataAsset 的通过依赖源码夹具内容出现在裁判输入里。
- 这次只重判，没有重新生成诊断。诊断质量、处理 agent 的稳定性不在本批范围内。
- 第一次尝试的 3 例结果已删除，没有混入最终记录。它的 token 计入本轮总花费。
