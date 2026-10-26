# Source snippet 验收记录

2026-10-26 完成代码、离线验收和本地健康故障闭环。真实七例未开始，状态为 blocked。线上诊断、处理和裁判都返回 429，替代 DeepSeek 渠道可用，但 GLM 裁判仍不可用。六次探测共回报 13 token，七例链路消耗为 0，预算为 400000。错误和用量见 `stop.json`，探测入口见 `probe-models.ts`。

## 与第 24 单逐例对照

第 24 单来自相邻目录 `2026-10-22-closed-loop-r3-prod/summary.json`。闭环判定是处理 agent 和裁判的结果，修复类别只看交付诊断，不把处理 agent 后读完整源码得到的答案算进诊断。

| 案例 | 第 24 单闭环 | 第 24 单 messageHardPass | 第 24 单修复类别 | 本次闭环 | 本次 messageHardPass | 本次修复类别 |
|---|---|---|---|---|---|---|
| dataasset-197 | closed | true | 修复尚未确定 | blocked | 未运行 | 未运行 |
| jvm-heap-oom | closed | true | 修复尚未确定 | blocked | 未运行 | 未运行 |
| cpu-quota-burst | closed | true | 修复尚未确定 | blocked | 未运行 | 未运行 |
| tag-group-502 | closed | true | 修复尚未确定 | blocked | 未运行 | 未运行 |
| sop-404 | closed | true | 修复尚未确定 | blocked | 未运行 | 未运行 |
| health-503 | closed | false | 兜底，诊断降级 | blocked | 未运行 | 未运行 |
| stack-overflow | closed | true | 修复尚未确定 | blocked | 未运行 | 未运行 |

DataAsset 和栈溢出没有本次模型修复动作原文，也不能检查实际模型是否写了“版本未核对”。离线测试证明两例上下文含 `unchecked` 源码和版本说明，且共享提示词强制要求该说明；这不证明真实模型遵守。

## 已运行的检查

- `pnpm --filter @pi-ops/agent test` 通过。覆盖根目录配置、路径穿越、符号链接逃逸、同名歧义、搜索不完整、赋值脱敏、missing、drifted、证据保留、幂等入库和正文隔离。
- `pnpm --filter @pi-ops/agent typecheck` 通过。
- `pnpm --filter @pi-ops/pi-runtime test` 通过，保留原有的可选 SDK smoke 跳过项。源码评测投影调用同一读取器，HTTP 简报测试使用临时磁盘 SQLite，验证引用原源码证据 id 的报告可入库且不出现第二条源码证据。
- `pnpm --filter @pi-ops/pi-runtime typecheck` 和 `pnpm build` 通过。
- `.agents/skills/verify-pi-ops/scripts/drive.sh launch` 不带 `--no-build`，构建成功。
- `drive.sh doctor`、`drill health`、`evidence` 和 `cleanup` 通过。FAKE 模型完成一次调查，Incident 恢复，首次与恢复通知均 DELIVERED，本地接收端匹配两个幂等键。没有真实企微流量。

最终运行应用证据在 `/Users/hejiayuan/.cache/verify-evidence/pi-ops/20261026T040959Z-86591/`。`drive-log.jsonl` 记录 launch、调查、恢复与通知；`compose-up.log` 保存实际构建；`cleanup.json` 记录清理。全套测试及构建输出在前一轮证据目录 `/Users/hejiayuan/.cache/verify-evidence/pi-ops/20261026T035117Z-61025/` 的 `agent-test.log`、`agent-typecheck.log`、`runtime-test.log`、`runtime-typecheck.log`、`build.log`。

继承的测试开始时已绿，不能称为本轮从零 TDD。本轮先增加稳定 id、字符上限、错误引用分类及重复源码入库等失败断言，再修实现。另对继承的缺失状态、脱敏、路径拒绝、证据排序和正文过滤做临时故障注入，见过 agent 12 项和 runtime 2 项失败，恢复实现后全绿。没有保留故障注入代码。

## 新坑 / 决定

- 评测会创建新的 Incident id。直接重新采集源码会生成另一个源码证据 id，原诊断引用无法对应。`source-snippet-projection.test.ts` 曾实测详情出现 `2 !== 1`。现在评测先保留模型看到的源码证据，调查入口仅在相同 kind 和 data 不存在时插入新记录。
- 全局额度恢复时间是 14:19:01，CPA 的冷却倒计时不是额度恢复时间。`stop.json` 记录了 429 原文，不能按较短冷却时间盲重试。
- `cpa/deepseek-v4.1-flash` 返回 503 无渠道，`cpa/deepseek-v4.1-flash-wong` 回答 OK，GLM 两个已配置别名均 429。没有用别的模型冒充原裁判。
- 本次不实现 matched。目录可读不等于对应运行版本；源码建议仍需要人工核对部署版本。

## 真实环境需要提供什么

提供事件实际写入的 `service` 字符串，以及 Agent 进程可读的绝对源码目录。用 `PI_OPS_SOURCE_ROOTS` JSON 逐服务配置。Agent 跑容器时，把目录只读挂入容器并填写容器内路径。根目录不能有同名源码歧义，不应包含生产配置与秘密。无需给模型 shell，不需要把源码放进应用容器。当前即使提供 revision 也不标 matched，版本核对仍由人完成。
