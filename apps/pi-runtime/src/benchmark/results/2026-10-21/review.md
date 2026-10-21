# 2026-10-21 真实模型值班消息评测结论

## 当前配置不能稳定形成值班消息

7 例各跑一次，只有栈溢出形成完整诊断及消息。其余 6 例的模型 JSON 不完整。总计 12 次模型调用，provider 回报输入 29345 token、输出 93821 token，共 123166 token。逐例耗时合计 558639 毫秒。这不是性能对照，也不是扣费金额。

本轮没有发送企微。唯一生成的消息由 fake fetch 捕获，3678 字节。6 例失败没有报告或最终消息，不能代写示例、补全 JSON 或把不存在的动作计为通过。

## 实际模型和配置来源

所有调用实际返回 `ark/deepseek-v4.1-flash`。请求和 Pi 会话 effective thinking 均为 `off`。来源是 `artifacts/real-dataasset-lab/central/start-runtime.sh:27-36` 显式使用的 `runtime-secrets.env` 及独立 `pi-agent/models.json`，模型目录配置 `maxTokens=8192`、`reasoning=true`。评测未保存密钥或模型目录中的认证字段。

没有运行中的 pi-runtime 容器可核实线上生效值。`deploy/local/.env` 另有 `cpa/deepseek-v4-flash-huoshan`，但基础 Compose 仅注入 `compose.env`，该文件无模型项。因此本轮使用最近真实 lab 的可追溯配置，不能声称确认了线上生产配置。

Pi 会话的 `off` 不等于上游关闭思考已得到证明。已安装 pi-ai 0.84.2 的 `dist/api/openai-completions.js:661-665` 在 OpenAI 兼容模式下，仅配置 `thinkingLevelMap.off` 时才发送关闭值。lab 模型没有该映射。当前适配器只返回 text 与 input/output token，不返回 thinking token 或 finish reason。空正文同时消耗 8192 输出 token 的原因很可能涉及上游思考或输出预算，但本轮没有捕获请求或 provider 原始事件，不能断言具体原因。

## 每例结果和自动检查

| 案例 | 输入 token | 输出 token | 耗时 ms | 完整报告 | 最终消息 | 自动内容检查 |
|---|---:|---:|---:|---|---|---|
| DataAsset 197 行 | 3239 | 8192 | 55175 | 无 | 无 | 未执行，整体失败 |
| JVM 堆 OOM | 7677 | 16384 | 106071 | 无 | 无 | 未执行，整体失败 |
| CPU 接近配额 | 4589 | 16384 | 90333 | 无 | 无 | 未执行，整体失败 |
| 标签组业务 502 | 1668 | 8192 | 46667 | 无 | 无 | 未执行，整体失败 |
| SOP 404 | 4426 | 15217 | 89090 | 无 | 无 | 未执行，整体失败 |
| health 503 | 1363 | 8192 | 51192 | 无 | 无 | 未执行，整体失败 |
| 栈溢出 | 6383 | 21260 | 120111 | 有 | 3678 字节 | 引用、动作字段、禁止断言筛查、字节和动作类别可见性全部通过 |

`messages.md` 包含每例状态及唯一最终消息的完整原文。每例 JSON 保存调用原文、初始模型视图、补证响应、实际模型、thinking 和 provider 用量。`summary.json` 聚合全部结果。自动内容检查未执行的案例不算通过。

全部 9 个失败输出都恰好达到 8192 output token。JVM OOM 两位专家分别只留下 168 字符与空正文。CPU 两位专家均为空正文。SOP 专家输出通过当前 schema，但 coordinator 停在 `"diagnosis":`。栈溢出的 container_host 专家也失败，JVM 专家和 coordinator 成功，说明专家失败隔离仍能让调查完成。详情见各例 `modelCalls`。

## 步骤 1 已有正向证据，步骤 2 和 3 仍有缺口

DataAsset 原始日志 197 行，第 133 行的异常头进入了模型投影。模型实际回答识别了 `Real DataAsset lab fault injection`，定位 `LabFaultController.serverFault:25`，还准确提及原始 197 行及保留范围 133 至 151 行。它不再声称只能看到初始化栈。这证明日志投影改善，不证明完整诊断或修复成功。

动作合同在 SOP 专家、栈溢出专家与 coordinator 的合法输出中生效。它们能表达对象、前提、操作、预期、风险、审批和引用。但当前模型配置下 6 例没有完整报告，不能把合同字段存在当成稳定可用。SOP 还建议通过 docker inspect 获取 Feign 有效环境变量，而实际 agent 投影会脱敏环境变量，现有能力不足以直接交付这类配置。证据在 `sop-404.json` 的专家动作与 `apps/agent/src/incident-context.ts` 的 `ENV_KEY` 和 `redactSecrets()`。

栈溢出消息保留了需审批的止损、验证、修复未知与两项补证，时间和前提未被删。这证明步骤 3 的类别优先选择与字节限制能工作。但完整诊断里的 `Recurse.java:7` 源码和递归边界检查没有进入消息。它是第三项 evidence_collection，被渲染器裁到“另有 2 条动作”。只看消息的人可推进临时恢复或补证，仍很难直接推进根治。完整操作在 `stack-overflow.json` 的 `investigation.report.diagnosis.actions`，正文不含该操作。没有修复生产代码。

人工判读是上述作者基于已保存消息与预先真值的判断，不是模型自评分或独立评审。请用户直接读 `messages.md` 判断是否愿意照做。不能用唯一成功案例推算总体成功率，也没有同输入旧版模型对照。

## 输入范围与完整链路边界

三个真实演练样本保存原始证据与源文件 SHA-256。标签组 502 和 SOP 404 仅重建测试中已观测的字段，不把旧结论交给模型。health 503 和栈溢出为现有测试来源的合成输入，不冒充历史真实演练。

初始证据使用 agent 的实际 `buildIncidentContext()`，8 项、8192 字节、20 行。历史知识固定为 unavailable，不涉及旧报告或真值。动态补证使用实际 `toRuntimeSafeEvidence()`，只按模型请求返回已有记录，其余返回 unavailable。由于三个真实案例都在第一轮专家阶段失败，真实调用未到达它们的成功补证；这一段通过离线检查，不是已被本轮真实模型走通的成功链路。栈溢出与 SOP 的补证请求正常返回 unavailable。

消息复用实际 notification payload 构造和 WeCom notifier，但不覆盖数据库落库、事件检测、通知策略、投递队列、恢复状态机或真实企微。评测时同目录另一会话正在改通知策略，已协商冻结 `notifier.ts` 与 `notification.ts`。其差异只有可选 notice 分支，评测不设置 notice。生产投影、提示词和渲染散列见 `summary.json.codeHashes`。第一例在增加散列记录前运行，其单例 JSON 未回填散列，相关文件在该期间未变；不要误认为每个文件都有独立运行时散列。

## 复跑命令

在仓库根目录执行下面的单条命令。请使用新输出目录，避免覆盖本次结果。依赖和本机 lab 配置必须存在。

```bash
PI_CODING_AGENT_DIR="$PWD/artifacts/real-dataasset-lab/central/pi-agent" pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/message-cli.ts --live --config artifacts/real-dataasset-lab/central/runtime-secrets.env --out artifacts/on-call-messages/next-run
```

增加 `--dry-run` 可只估算。中断后同目录加 `--resume`，已保存案例不会再次调用模型。本轮首例失败后暂停，随后通过 resume 继续其余六例，没有重跑首例。保守估算为 700000 token，预算为 1000000 token。全部实际用量为 123166 token，没有超过预算。没有切换模型、提高输出上限或增加付费对照。

## 本轮验证

- `pnpm --filter @pi-ops/pi-runtime test`。73 通过，0 失败，1 个可选 SDK smoke 跳过。原基线 69 个通过保持。
- `pnpm --filter @pi-ops/pi-runtime typecheck` 与 `build`。通过。
- `pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/message-cli.ts --out /tmp/pi-message-seven`。7 例 fake 全部形成消息，fake fetch 各调用一次。fake 没有止损动作，检查如实不通过，不能当质量结论。
- `message-chain.test.ts`。4 个新增测试通过，覆盖 197 行故障头、固定补证、真实渲染器 fake fetch、引用和动作结构、4001 字节拒绝、失败专家账单用量以及预算阻止调用。
- 默认 CLI dry-run 显示 7 例和 700000 token。覆盖已有结果时拒绝。resume 对已有 7 例只读取，不再调用模型。最终真实模式 resume 退出码为 1，因为 6 例质量失败，不把完成运行误报为评测通过。
- `git diff --check -- apps/pi-runtime/src/benchmark`。通过。样本凭据模式扫描未发现 key，结果文件另以本机实际 key 值检查，不输出 key。

## 新坑 / 决定

- 当前输出上限下，真实模型经常无法交付完整 JSON。证据为 9 个失败调用均 outputTokens=8192，以及 `sop-404.json` coordinator 末尾的 `"diagnosis":`。不在本轮改生产提示词、解析器或输出配置。
- `thinking=off` 目前只能证明 SDK 会话值。证据为 adapter 返回字段与 pi-ai 的 off 映射分支。后续若要确认关闭效果，需捕获脱敏请求参数及 provider finish reason，不能只看配置名。
- 动作有类别不等于手机消息保住关键根治检查。证据为栈溢出源码检查存在于完整 actions，但不在 3678 字节消息。自动检查仍通过，语义有用性必须人工看。
- 此轮按最近真实 lab 的明确启动路径选模型，没有声称核实线上配置。证据为 `start-runtime.sh` 和基础 Compose 的不同 env 接线。

没有外发企微，没有重跑失败案例，没有修改 agent 生产代码，没有推送。本轮只评价保存证据到诊断消息的离线调用链，不能宣称真实故障恢复或生产通知策略已经验收。
