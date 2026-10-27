# 诊断证据边界修复与闭环重跑

## 结论

本轮完整重跑 7 例，固定裁判判定为 6/7 闭环，基线为 `8ae4a0a` 的 5/7。OOM 从 open 变为 closed，CPU 仍为 open，其余 5 例保持 closed。CPU 和 OOM 最终详情中不再有无依据的演练或业务无影响结论。DataAsset 处理 agent 仍能读取源码并引用第 25 行确认注入入口。

这不是全部问题已经解决。CPU 处理 agent 在读源码后仍自行推断为演练误报。OOM 处理回答仍写“自触发、可自愈的演练型堆耗尽”，裁判接受了它的源码解释。6/7 仅是固定裁判的本轮结果，不代表人工确认 6 个故障已恢复，也不证明没有剩余无依据归因。

## 改动

- `apps/pi-runtime/src/specialists.ts` 在专家诊断和 coordinator 共用的 `CURRENT_EVIDENCE_LIMITS` 中新增三条规则。环境名只能作为命名事实。注入定性需要与当前异常对应的源码或日志明确证据及出处。没有业务指标证据时写影响未确认并给确认方法。约束覆盖摘要、候选原因及动作前提，汇总时须回查原始证据。
- `apps/pi-runtime/src/__tests__/plain-summary.test.ts` 新增只有 `/orders-local-drill` 容器名的输入。实际调用 `investigate()`，检查两个专家及 coordinator 共三份模型请求均保留输入名称并携带上述约束。
- 本目录新增 7 份案例 JSON、`summary.json`、`report.md` 和本文件。原结果目录不改。

生产改动仅为提示词，没有新增条件分支、文本删除器或案例特判。`coordinator.ts` 已复用该提示词，因此不需要改。`apps/agent` 未改。`closed-loop-cases.ts`、处理 agent 提示词和裁判提示词均未改。

## 模型与预算

- 诊断模型为 `ark/deepseek-v4.1-flash`，thinking off。模型目录为 `results/2026-10-21-output-budget/pi-agent`。`cmp deploy/docker/models.json apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent/models.json` 退出 0。
- 处理 agent 为 `cpa/deepseek-flash-latest`，裁判为 `cpa/glm-latest`，均为 thinking off。没有换模型。
- provider 回报用量合计 327388 token，低于 400000。包括结构化输出内部重试。没有重跑案例，没有重判。没有遇到 429。
- 各例耗时合计 1337033 ms。耗时只是运行记录，不是性能对比。
- 完整 dry-run 在调用模型前拒绝执行，原文为 `estimated tokens=665000 exceed budget=400000`。CLI 固定按每例 95000 token 估算，因此改用同一 CLI 的 `--case` 顺序跑完整链路，每例先 dry-run，再把全局剩余额度传入 `--budget`。没有放宽预算检查。

| 案例 | 开始时剩余额度 | 本例 token | 累计 token |
|---|---:|---:|---:|
| dataasset-197 | 400000 | 40616 | 40616 |
| jvm-heap-oom | 359384 | 87590 | 128206 |
| cpu-quota-burst | 271794 | 92307 | 220513 |
| tag-group-502 | 179487 | 27215 | 247728 |
| sop-404 | 152272 | 28370 | 276098 |
| health-503 | 123902 | 18742 | 294840 |
| stack-overflow | 105160 | 32548 | 327388 |

逐例命令如下。将表中的案例和开始时剩余额度分别代入 `CASE` 和 `REMAINING`。每例都重新生成诊断、启动真实本机 HTTP agent、写临时 SQLite、读取鉴权详情，再调用处理 agent 和裁判。通知 fetch 为捕获替身，不发企微。夹具事件和证据由装置直接写入 store，不能把它称为真实故障产生和采证的端到端测试。

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --case "$CASE" --budget "$REMAINING" --dry-run \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --case "$CASE" --budget "$REMAINING" --resume \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop
```

单例 CLI 每次会覆盖汇总表，所以结束后只读 7 个 `<case>.json`，用原有 `renderClosedLoopReport()` 合并生成 `report.md`。`summary.json` 同步汇总 7 例，保留 `caseBudgets` 和执行方式。没有更改每例原始结果。

## 与 5/7 基线逐例比较

| 案例 | 2026-10-21 收紧重判 | 本轮 | 本轮失败项 | 说明 |
|---|---|---|---|---|
| dataasset-197 | closed | closed | 无 | 处理 agent 引用 LabFaultController.java:25 明确注入 |
| jvm-heap-oom | open | closed | 无 | 最终详情不再无据定性演练，处理回答仍有判定风险 |
| cpu-quota-burst | open | open | root_cause、repair、no_forbidden | 详情已收紧，处理 agent 读源码后又推断演练误报 |
| tag-group-502 | closed | closed | 无 | 保留缺源码及触发逻辑未知 |
| sop-404 | closed | closed | 无 | 保留 404 契约与触发原因待核对 |
| health-503 | closed | closed | 无 | 保留不可用风险和条件止损 |
| stack-overflow | closed | closed | 无 | 保留递归路径与触发入口未知 |

基线来自 `../2026-10-21-closed-loop-rejudge/review.md`。本轮逐项理由在 `report.md` 和各案例的 `result.judge.items`。7 例均完成、无降级，`diagnosis.reportHardPass` 全为 true。`diagnosis.messageHardPass` 全为 false，不能把这些字段报告成全绿。现有 `evaluateMessage()` 仍要求消息出现“止损：”“修复：”“验证：”标签，而当前通知是人话摘要。用本轮保存的报告和消息重算可复现这三项可见性失败。本任务不改这套检查。

## CPU 最终详情原文

`cpu-quota-burst.json` 的 `result.detail.markdown` 包含：

> 压力是否持续、是否throttling及业务影响均未确认。

> 无请求错误率、关键接口失败或用户报障证据，业务影响未确认。

> 核对窗口内请求错误率、关键接口成功率与用户报障记录；如缺失则说明影响未确认，必要时低峰期人工受控复现一次并对比jdk.CPULoad与throttling指标。

场景只写“order-service 本地容器 order-local-drill-20261004-053526-be8ec9”，没有把名称解释为本次是演练。保留了配额 `NanoCpus=2000000000`、两个 stats 区间计数及原始服务名，没有删事实。

但处理回答 `result.handler.answer.rootCause` 写：

> 证据更支持“容器启动初期短时CPU开销 + 演练阈值配置过低导致的单点告警”，而非持续CPU压力或业务故障。

裁判 `no_forbidden` 判 false：

> 现有证据仅有环境/服务名带“演练”、源码具备/cpu注入能力，均不构成本次事件是预期演练的证据，方案自己也承认“无直接证据”。

CPU 诊断仍有“更像启动初期短时CPU开销”的未核实候选，但没有再称演练或无影响。处理回答还把 jvmUser=0.194 写成“属单核约19%”，与机器归一化口径不符。该问题在处理回答中，本轮没有改处理 agent 或评测标准。

## OOM 最终详情原文

`jvm-heap-oom.json` 的 `result.detail.markdown` 包含：

> 环境名含“演练”只是命名事实，现有证据没有说明本次是否为故障注入。业务影响也尚未确认。

> 业务影响未确认：缺少故障窗口请求错误率、关键接口失败与用户报障证据。

> 核对 2026-10-04T05:30 前后的请求错误率、关键接口成功率与用户报障；若调整堆参数或修复分配逻辑，经审批后灰度并回看同窗口指标。

摘要写“堆上限与业务影响未确认”，保留 Java heap space、Drill.exhaustHeap、OOMKilled=false 和主机内存事实，严重级别仍为严重。最终详情不再写“演练实例”或“倾向于演练分配触发”。

一个早期专家原始输出仍写“本地演练容器”，该输出的 `diagnosis.summary` 结构校验失败后触发重试。最终汇总没有沿用这个说法。这说明提示词不能保证每次内部输出都遵守规则。

处理回答仍写：

> 源码与证据一致地指向“自触发、可自愈的演练型堆耗尽”，不是生产堆泄漏或堆参数过小。

裁判 `no_forbidden` 判 true，并认为唯一入口、释放日志和事件对应足以支持注入定性。处理回答却在 unknowns 中承认“谁……调用了 POST /heap，是否为计划内演练”未知。按用户要求的证据边界，源码具备该路径不等于证明本次是预期演练。保留原始判定，不人工改标签，也不重判到满意。

## DataAsset 仍能引用明确注入证据

`dataasset-197.json` 的处理 agent 第 2 轮读取 `apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java`，随后写：

> 该方法在第25行无条件抛出 IllegalStateException("Real DataAsset lab fault injection")，异常文本与栈顶行号同日志完全一致。

裁判 8 项全过，`diagnosis_truth` 理由明确认可诊断保留“触发条件与调用方未知”“业务影响未确认”。收紧没有禁止有明确源码出处的注入结论。

## 测试与类型检查

先添加只有容器名的回归输入，再修改生产提示词。同一命令改前失败，原文为：

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /环境标签只能作为事实陈述/.
```

改后输出为：

```text
✔ constrains label-only inference and unconfirmed business impact in every specialist and summary prompt
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

运行的验证命令如下：

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx --test src/__tests__/plain-summary.test.ts
pnpm --filter @pi-ops/pi-runtime test
pnpm --filter @pi-ops/pi-runtime typecheck
git diff --check
```

- 全量测试 89 项，88 通过，1 项原有可选 SDK smoke 跳过，0 失败。
- 第一次类型检查发现测试导入名错误 `TS2305: Module '"../model.js"' has no exported member 'ModelRequest'`。改用现有 `RuntimeModelRequest` 后通过。
- `git diff --check` 通过。
- 没改 `apps/agent`，未额外跑它的全量测试。真实重跑已使用 agent 的存储、HTTP 详情和通知渲染器。

## 新坑 / 决定

1. 总预算估算与实际成本不能混为一谈。完整 dry-run 报 `estimated tokens=665000 exceed budget=400000`，而本轮实报 327388。决定按全局剩余额度逐例执行，不改 CLI 的保守门槛。
2. CPU 仍有处理阶段的无依据降级。证据是 `cpu-quota-burst.json` 的 `result.handler.answer` 与 `result.judge.items`。决定保留 open，不修改处理 agent 和裁判。
3. OOM 裁判存在接受无据“演练型”定性的风险。证据是 `jvm-heap-oom.json` 的 `handler.answer.rootCause`、`unknowns` 与 `judge.items[id=no_forbidden]`。决定原样报告 closed，但不宣称此项语义风险已解决。
4. 人话摘要与旧消息可见性自动检查不一致。证据是 `evaluator.ts` 的标签正则、本轮 7 例 `messageHardPass=false` 及保存的消息。决定不在本任务修改评测标准。
5. SDK 运行时在旧模型目录自动生成 2 字节空对象 `pi-agent/auth.json`。只确认其为空，不读取密钥。决定不提交这个范围外产物。
